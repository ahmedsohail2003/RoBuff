// A rock, not a spiky ball: an icosphere pushed by layered smooth noise, chipped by
// a few flat cuts and marked by a few craters.

import { fitToBox, smoothMesh, type ObjectMesh } from '../mesh';
import { SmoothNoise } from '../noise';
import { createRng, randomInt, randomUnit, range, streamSeed, type Rng } from '../rng';
import type { ObjectSpec } from '../spec';

/** Subdivided 3 times: 642 vertices and 1280 triangles. */
export const ICOSPHERE_SUBDIVISIONS = 3;

/** Unit-sphere icosphere, built with sqrt only. */
export function icosphere(subdivisions: number): { points: Float64Array; indices: Uint32Array } {
  const t = (1 + Math.sqrt(5)) / 2;
  const corners: [number, number, number][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const verts: number[] = [];
  const unit = (x: number, y: number, z: number): number => {
    const len = Math.sqrt(x * x + y * y + z * z);
    verts.push(x / len, y / len, z / len);
    return verts.length / 3 - 1;
  };
  for (const [x, y, z] of corners) unit(x, y, z);
  let tris: number[] = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
    1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
    4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ];
  for (let s = 0; s < subdivisions; s++) {
    const cache = new Map<number, number>();
    const mid = (a: number, b: number): number => {
      const key = a < b ? a * 1_000_000 + b : b * 1_000_000 + a;
      let m = cache.get(key);
      if (m === undefined) {
        m = unit(verts[a * 3]! + verts[b * 3]!, verts[a * 3 + 1]! + verts[b * 3 + 1]!, verts[a * 3 + 2]! + verts[b * 3 + 2]!);
        cache.set(key, m);
      }
      return m;
    };
    const next: number[] = [];
    for (let i = 0; i < tris.length; i += 3) {
      const a = tris[i]!;
      const b = tris[i + 1]!;
      const c = tris[i + 2]!;
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    tris = next;
  }
  return { points: Float64Array.from(verts), indices: Uint32Array.from(tris) };
}

interface Crater {
  x: number;
  y: number;
  z: number;
  radius: number;
  depth: number;
}

function makeCraters(rng: Rng, roughness: number): Crater[] {
  const count = randomInt(rng, 2, 3) + Math.round(roughness * 2);
  const craters: Crater[] = [];
  for (let i = 0; i < count; i++) {
    const [x, y, z] = randomUnit(rng);
    const radius = range(rng, 0.32, 0.62);
    craters.push({ x, y, z, radius, depth: radius * range(rng, 0.17, 0.27) });
  }
  return craters;
}

/** A bowl inside the radius and a low raised rim just outside it, smooth at every join. */
function craterOffset(c: Crater, dx: number, dy: number, dz: number): number {
  const chord = Math.sqrt((dx - c.x) ** 2 + (dy - c.y) ** 2 + (dz - c.z) ** 2);
  const t = chord / c.radius;
  if (t < 1) {
    const u = 1 - t * t;
    return -c.depth * u * u + c.depth * 0.2 * t * t * t * t;
  }
  if (t < 1.5) {
    const u = (1.5 - t) / 0.5;
    return c.depth * 0.2 * u * u * (3 - 2 * u);
  }
  return 0;
}

export function buildAsteroid(spec: ObjectSpec): ObjectMesh {
  const { points: sphere, indices } = icosphere(ICOSPHERE_SUBDIVISIONS);
  const noise = new SmoothNoise(createRng(streamSeed(spec.seed, 0x51)));
  const shape = createRng(streamSeed(spec.seed, 0x52));
  const craters = makeCraters(createRng(streamSeed(spec.seed, 0x53)), spec.roughness);

  const ox = range(shape, -50, 50);
  const oy = range(shape, -50, 50);
  const oz = range(shape, -50, 50);
  const lumpAmount = 0.1 + 0.28 * spec.lumpiness;
  const detailAmount = 0.015 + 0.05 * spec.roughness;
  const depthRatio = range(shape, 0.72, 0.95);

  // Flat chips, as on broken rock. More lumpiness, more chips.
  const cuts: { x: number; y: number; z: number; offset: number }[] = [];
  const cutCount = randomInt(shape, 1, 2) + Math.round(spec.lumpiness * 2);
  for (let i = 0; i < cutCount; i++) {
    const [x, y, z] = randomUnit(shape);
    cuts.push({ x, y, z, offset: range(shape, 0.72, 0.92) });
  }

  const points = new Float64Array(sphere.length);
  for (let i = 0; i < sphere.length; i += 3) {
    const dx = sphere[i]!;
    const dy = sphere[i + 1]!;
    const dz = sphere[i + 2]!;
    // Low frequency for the big lumps, higher for surface detail, both under what 642 vertices can show.
    let radius = 1;
    radius += lumpAmount * noise.layered(dx * 1.05 + ox, dy * 1.05 + oy, dz * 1.05 + oz, 2);
    radius += detailAmount * noise.layered(dx * 3.2 + oz, dy * 3.2 + ox, dz * 3.2 + oy, 2);
    for (const crater of craters) radius += craterOffset(crater, dx, dy, dz);

    let x = dx * radius;
    let y = dy * radius;
    let z = dz * radius;
    for (const cut of cuts) {
      const over = x * cut.x + y * cut.y + z * cut.z - cut.offset;
      if (over > 0) {
        x -= over * 0.85 * cut.x;
        y -= over * 0.85 * cut.y;
        z -= over * 0.85 * cut.z;
      }
    }
    points[i] = x;
    points[i + 1] = y;
    points[i + 2] = z;
  }

  const width = spec.width_mm / 1000;
  fitToBox(points, { x: width, y: width * depthRatio, z: spec.height_mm / 1000 });
  return smoothMesh(points, indices);
}
