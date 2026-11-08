// An assembly: a recognisable thing (a rifle, a plane, a car) built from up to 8 primitive
// parts. Each part reuses the single-shape generator of its shape, is sized in millimetres,
// turned about its own centre (x, then y, then z, fixed axes), then moved to its place in the
// object frame (z up). For display the parts merge into one mesh with a colour per vertex; for
// physics each part keeps its own mesh, so MuJoCo collides with every part's own convex hull.
// Same spec, same bytes: each part's seed is drawn from the spec seed and the part's index.

import { convexHull, type ConvexHull } from '../hull';
import { flatMesh, smoothMesh, type ObjectMesh } from '../mesh';
import { streamSeed } from '../rng';
import type { ObjectSpec, PartShape, PartSpec } from '../spec';
import { buildBox } from './box';
import { buildCone } from './cone';
import { buildCylinder } from './cylinder';
import { buildSphere } from './sphere';

const BUILDERS: Readonly<Record<PartShape, (spec: ObjectSpec) => ObjectMesh>> = {
  box: buildBox,
  cylinder: buildCylinder,
  sphere: buildSphere,
  cone: buildCone,
};

/** Parts keep edges nearly sharp: a rifle receiver is not a soft brick. */
const PART_LUMPINESS = 0.08;
const DEG = Math.PI / 180;

export interface BuiltPart {
  index: number;
  name: string;
  shape: PartShape;
  color: string;
  /** In metres, in the object frame. */
  mesh: ObjectMesh;
  /**
   * The part's convex hull in the object frame. It is found in the part's own axis-aligned frame
   * and then turned and moved with it: hulling the turned points directly is not robust, because
   * Float32 rounding leaves a turned flat face full of nearly coplanar points.
   */
  hull: ConvexHull;
}

/** Row-major 3x3 for a turn about x, then y, then z (fixed axes): R = Rz * Ry * Rx. */
export function rotationMatrix(rotDeg: readonly [number, number, number]): number[] {
  const [a, b, c] = rotDeg.map((d) => d * DEG) as [number, number, number];
  const [ca, sa, cb, sb, cc, sc] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(c), Math.sin(c)];
  return [
    cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa,
    sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa,
    -sb, cb * sa, cb * ca,
  ];
}

/** The parts a spec describes. A spec of kind assembly without parts is one box of its width, depth and height. */
export function partsOf(spec: ObjectSpec): PartSpec[] {
  if (spec.parts && spec.parts.length > 0) return spec.parts;
  return [{ name: spec.name || 'body', shape: 'box', size_mm: [spec.width_mm, spec.depth_mm ?? spec.width_mm, spec.height_mm], pos_mm: [0, 0, 0], rot_deg: [0, 0, 0], color: spec.color }];
}

/** Applies x' = M x + t to hull points. Faces carry over: a turn, a move, or a stretch along an axis keeps a hull convex and its winding. */
export function mapHull(hull: ConvexHull, m: readonly number[], t: readonly [number, number, number]): ConvexHull {
  const p = hull.points;
  const out = new Float64Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    out[i] = m[0]! * p[i]! + m[1]! * p[i + 1]! + m[2]! * p[i + 2]! + t[0];
    out[i + 1] = m[3]! * p[i]! + m[4]! * p[i + 1]! + m[5]! * p[i + 2]! + t[1];
    out[i + 2] = m[6]! * p[i]! + m[7]! * p[i + 1]! + m[8]! * p[i + 2]! + t[2];
  }
  const det = m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) - m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) + m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!);
  return { points: out, faces: hull.faces, volume: hull.volume * det };
}

/**
 * Each distinct point once. Flat-shaded meshes repeat every corner for each face it touches, and
 * the hull builder gave a turned box nearly eight times its real volume from those repeats
 * (measured: 3.34 against 0.42 cm3 for a box turned 20 degrees); without them it is exact.
 */
export function uniquePoints(positions: ArrayLike<number>): Float64Array {
  const seen = new Set<string>();
  const out: number[] = [];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const key = positions[i] + ',' + positions[i + 1] + ',' + positions[i + 2];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(positions[i]!, positions[i + 1]!, positions[i + 2]!);
  }
  return Float64Array.from(out);
}

/** One part's mesh and hull in the object frame, metres. */
export function buildPartWithHull(part: PartSpec, seed: number, index: number, lumpiness = PART_LUMPINESS): { mesh: ObjectMesh; hull: ConvexHull } {
  const local: PartSpec = { ...part, pos_mm: [0, 0, 0], rot_deg: [0, 0, 0] };
  const straight = buildPart(local, seed, index, lumpiness);
  const hull0 = convexHull(uniquePoints(straight.positions));
  const mesh = buildPart(part, seed, index, lumpiness);
  const hull = hull0 ? mapHull(hull0, rotationMatrix(part.rot_deg), part.pos_mm.map((v) => v / 1000) as [number, number, number]) : { points: new Float64Array(0), faces: new Uint32Array(0), volume: 0 };
  return { mesh, hull };
}

/** One part's mesh in the object frame, metres. */
export function buildPart(part: PartSpec, seed: number, index: number, lumpiness = PART_LUMPINESS): ObjectMesh {
  const [sx, sy, sz] = part.size_mm;
  const primitive: ObjectSpec = {
    kind: part.shape,
    width_mm: sx,
    depth_mm: sy,
    height_mm: sz,
    roughness: 0,
    lumpiness,
    seed: streamSeed(seed, 0xa0 + index),
    material: 'aluminium',
    color: part.color,
    why: '',
  };
  const raw = BUILDERS[part.shape](primitive);
  // The box takes its depth itself; the round shapes come out with a square footprint.
  const yScale = part.shape === 'box' ? 1 : sy / sx;
  const r = rotationMatrix(part.rot_deg);
  const [px, py, pz] = part.pos_mm.map((v) => v / 1000) as [number, number, number];
  const points = new Float64Array(raw.positions.length);
  for (let i = 0; i < points.length; i += 3) {
    const x = raw.positions[i]!;
    const y = raw.positions[i + 1]! * yScale;
    const z = raw.positions[i + 2]!;
    points[i] = r[0]! * x + r[1]! * y + r[2]! * z + px;
    points[i + 1] = r[3]! * x + r[4]! * y + r[5]! * z + py;
    points[i + 2] = r[6]! * x + r[7]! * y + r[8]! * z + pz;
  }
  // Normals again from the moved points: a stretched footprint changes them.
  return part.shape === 'sphere' ? smoothMesh(points, raw.indices) : flatMesh(points, raw.indices);
}

export function buildAssemblyParts(spec: ObjectSpec): BuiltPart[] {
  const lumpiness = spec.parts && spec.parts.length > 0 ? PART_LUMPINESS : spec.lumpiness;
  return partsOf(spec).map((part, index) => ({ index, name: part.name, shape: part.shape, color: part.color, ...buildPartWithHull(part, spec.seed, index, lumpiness) }));
}

export function hexToRgb(color: string): [number, number, number] {
  const hex = /^#[0-9a-f]{6}$/i.test(color) ? color : '#808080';
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** All parts in one mesh for display, with each part's colour on its vertices. */
export function mergeParts(parts: readonly { mesh: ObjectMesh; color: string }[]): ObjectMesh {
  const vertices = parts.reduce((n, p) => n + p.mesh.positions.length / 3, 0);
  const triangles = parts.reduce((n, p) => n + p.mesh.indices.length, 0);
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const colors = new Float32Array(vertices * 3);
  const indices = new Uint32Array(triangles);
  let v = 0;
  let t = 0;
  for (const part of parts) {
    const count = part.mesh.positions.length / 3;
    positions.set(part.mesh.positions, v * 3);
    normals.set(part.mesh.normals, v * 3);
    const [r, g, b] = hexToRgb(part.color);
    for (let k = 0; k < count; k++) colors.set([r, g, b], (v + k) * 3);
    for (let k = 0; k < part.mesh.indices.length; k++) indices[t + k] = part.mesh.indices[k]! + v;
    v += count;
    t += part.mesh.indices.length;
  }
  return { positions, indices, normals, colors };
}

export function buildAssembly(spec: ObjectSpec): ObjectMesh {
  const lumpiness = spec.parts && spec.parts.length > 0 ? PART_LUMPINESS : spec.lumpiness;
  return mergeParts(partsOf(spec).map((part, index) => ({ color: part.color, mesh: buildPart(part, spec.seed, index, lumpiness) })));
}
