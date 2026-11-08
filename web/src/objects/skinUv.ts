// Texture coordinates for skins. Spawned objects are generated meshes with no UVs, so a skin is
// box-projected: each triangle takes the image from the side of a box it faces most, fitted to
// the whole object (one picture runs across every part) or to one part's own box (so four wheels
// look alike). Pure: no DOM and no three.js, so Node tests cover it. Paint only: nothing here
// touches the hulls, the mass or the MJCF.

import type { ObjectMesh } from './mesh';
import type { Receipt } from './receipt';
import type { ObjectKind } from './spec';

/** One part's run of triangle corners in the merged mesh, in index units. */
export interface PartRange {
  index: number;
  name: string;
  start: number;
  count: number;
}

/** What a spawned object is called when its spec has no name. */
export const KIND_NAMES: Readonly<Record<ObjectKind, string>> = {
  asteroid: 'rock sample',
  panel: 'solar panel',
  dish: 'dish',
  bus: 'satellite bus',
  fragment: 'fragment',
  box: 'box',
  cylinder: 'cylinder',
  sphere: 'ball',
  cone: 'cone',
  assembly: 'model',
};

/** The spoken and shown name of an object: its spec name, else a word for its kind. */
export function displayName(receipt: Pick<Receipt, 'spec'>): string {
  return receipt.spec.name?.trim() || KIND_NAMES[receipt.spec.kind];
}

/**
 * Each part's index range in receipt.mesh. mergeParts concatenates the parts in receipt order,
 * so the ranges are a running sum. A single shape is one range named after the object.
 */
export function partRanges(receipt: Pick<Receipt, 'spec' | 'mesh' | 'parts'>): PartRange[] {
  const total = receipt.mesh?.indices.length ?? 0;
  const parts = receipt.parts ?? [];
  if (parts.length === 0) return [{ index: 0, name: displayName(receipt), start: 0, count: total }];
  const out: PartRange[] = [];
  let start = 0;
  parts.forEach((part, index) => {
    out.push({ index, name: part.name, start, count: part.mesh.indices.length });
    start += part.mesh.indices.length;
  });
  return out;
}

/**
 * One vertex per triangle corner with an identity index. Each part can then take its own UVs
 * without sharing a vertex with its neighbour, and the triangle and range counts stay the same.
 */
export function deindex(mesh: ObjectMesh): ObjectMesh {
  const n = mesh.indices.length;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const hasNormals = mesh.normals.length === mesh.positions.length;
  const colors = mesh.colors && mesh.colors.length === mesh.positions.length ? new Float32Array(n * 3) : undefined;
  const indices = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const v = mesh.indices[i]! * 3;
    const o = i * 3;
    positions[o] = mesh.positions[v]!;
    positions[o + 1] = mesh.positions[v + 1]!;
    positions[o + 2] = mesh.positions[v + 2]!;
    if (hasNormals) {
      normals[o] = mesh.normals[v]!;
      normals[o + 1] = mesh.normals[v + 1]!;
      normals[o + 2] = mesh.normals[v + 2]!;
    }
    if (colors) {
      colors[o] = mesh.colors![v]!;
      colors[o + 1] = mesh.colors![v + 1]!;
      colors[o + 2] = mesh.colors![v + 2]!;
    }
    indices[i] = i;
  }
  if (!hasNormals) faceNormals(positions, normals);
  return colors ? { positions, indices, normals, colors } : { positions, indices, normals };
}

function faceNormals(positions: Float32Array, normals: Float32Array): void {
  for (let t = 0; t < positions.length; t += 9) {
    const ux = positions[t + 3]! - positions[t]!;
    const uy = positions[t + 4]! - positions[t + 1]!;
    const uz = positions[t + 5]! - positions[t + 2]!;
    const vx = positions[t + 6]! - positions[t]!;
    const vy = positions[t + 7]! - positions[t + 1]!;
    const vz = positions[t + 8]! - positions[t + 2]!;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    for (let k = 0; k < 9; k += 3) {
      normals[t + k] = nx;
      normals[t + k + 1] = ny;
      normals[t + k + 2] = nz;
    }
  }
}

/** The box a skin is fitted to: its centre in metres and its longest side in mm. */
export interface UvAnchor {
  centre: [number, number, number];
  spanMm: number;
}

/** The fitted box of corners start..start+count of a deindexed mesh (positions in metres). */
export function anchorOf(positions: Float32Array, start: number, count: number): UvAnchor {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = start; i < start + count; i++) {
    for (let a = 0; a < 3; a++) {
      const p = positions[i * 3 + a]!;
      if (p < min[a]!) min[a] = p;
      if (p > max[a]!) max[a] = p;
    }
  }
  if (!Number.isFinite(min[0]!)) return { centre: [0, 0, 0], spanMm: 1 };
  const spanMm = Math.max(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!) * 1000;
  return {
    centre: [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2],
    spanMm: spanMm > 1e-6 ? spanMm : 1,
  };
}

/**
 * Box-projected UVs for the triangles in corners start..start+count of a deindexed mesh.
 * Each triangle picks the axis its face normal points along most (ties go to z) and its sign:
 *   X faces (u, v) = (s*dy, dz), Y faces (-s*dx, dz), Z faces (dx, s*dy),
 * so no face is mirrored seen from outside and v is up on the side faces. Scaled by the
 * anchor's longest side, every u and v lands in [0, 1] and the image never wraps.
 */
export function boxUv(positions: Float32Array, uv: Float32Array, start: number, count: number, anchor: UvAnchor): void {
  const k = 1000 / anchor.spanMm;
  const [cx, cy, cz] = anchor.centre;
  const end = start + count - (count % 3);
  for (let i = start; i < end; i += 3) {
    const p = i * 3;
    const ux = positions[p + 3]! - positions[p]!;
    const uy = positions[p + 4]! - positions[p + 1]!;
    const uz = positions[p + 5]! - positions[p + 2]!;
    const vx = positions[p + 6]! - positions[p]!;
    const vy = positions[p + 7]! - positions[p + 1]!;
    const vz = positions[p + 8]! - positions[p + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);
    const axis = az >= ax && az >= ay ? 2 : ax >= ay ? 0 : 1;
    const s = (axis === 0 ? nx : axis === 1 ? ny : nz) < 0 ? -1 : 1;
    for (let c = 0; c < 3; c++) {
      const q = (i + c) * 3;
      const dx = positions[q]! - cx;
      const dy = positions[q + 1]! - cy;
      const dz = positions[q + 2]! - cz;
      let u: number;
      let v: number;
      if (axis === 0) {
        u = s * dy;
        v = dz;
      } else if (axis === 1) {
        u = -s * dx;
        v = dz;
      } else {
        u = dx;
        v = s * dy;
      }
      uv[(i + c) * 2] = clamp01(u * k + 0.5);
      uv[(i + c) * 2 + 1] = clamp01(v * k + 0.5);
    }
  }
}

/** Float rounding at the box edge must never step outside [0, 1]. */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

const ALL_WORDS = new Set(['', 'all', 'whole', 'everything', 'it', 'all parts', 'every part', 'the whole thing', 'whole thing', 'all of it', 'the whole object', 'whole object']);
const FILLER = new Set(['the', 'a', 'an', 'its', 'it', 's', 'of', 'all', 'both', 'every', 'each', 'part', 'parts', 'on', 'my']);

function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** wheels -> wheel, batteries -> battery, boxes -> box; glass stays glass. */
export function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(ses|xes|zes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function words(text: string): string[] {
  return norm(text)
    .split(' ')
    .filter((w) => w && !FILLER.has(w))
    .map(singular);
}

/**
 * Which parts a phrase names, by index. Null, 'all', 'whole' or 'everything' mean every part.
 * Then, first rule that matches wins: exact name; plural or singular ('wheels' -> each 'wheel');
 * all the words present ('front wheels' -> both front wheels); substring. [] when nothing does.
 */
export function matchParts(names: readonly string[], query: string | null | undefined): number[] {
  const all = names.map((_, i) => i);
  const q = norm(query ?? '');
  if (ALL_WORDS.has(q) || ALL_WORDS.has(q.replace(/^the /, ''))) return all;
  const qWords = words(q);
  if (qWords.length === 0) return all;
  const named = names.map((n) => ({ text: norm(n), words: words(n) }));
  const pick = (test: (n: { text: string; words: string[] }) => boolean): number[] => all.filter((i) => test(named[i]!));
  const stripped = q.replace(/^(the|its|all the|both|every|each) /, '');
  let hit = pick((n) => n.text === q || n.text === stripped);
  if (hit.length) return hit;
  const qJoined = qWords.join(' ');
  hit = pick((n) => n.words.join(' ') === qJoined);
  if (hit.length) return hit;
  hit = pick((n) => qWords.every((w) => n.words.includes(w)));
  if (hit.length) return hit;
  hit = pick((n) => n.text.includes(stripped) || (n.text.length >= 3 && stripped.includes(n.text)));
  return hit;
}
