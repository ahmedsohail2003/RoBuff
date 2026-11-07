// Pure measurements on point sets: sanity checks, extents, widths.

import { closedVolume, type ConvexHull } from './hull';
import { YAW_STEP_DEG } from './limits';

export type SanityProblem = 'not_finite' | 'too_few_vertices' | 'bad_index' | 'coincident' | 'collinear' | 'coplanar';

export interface SanityResult {
  ok: boolean;
  problem: SanityProblem | null;
  vertex_count: number;
  non_finite_values: number;
  /** Spread across the thinnest direction found, in the mesh's units. Zero if flat. */
  thickness: number;
}

export interface Extents {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
}

export function countNonFinite(values: ArrayLike<number>): number {
  let bad = 0;
  for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i]!)) bad++;
  return bad;
}

export function extents(positions: ArrayLike<number>): Extents {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/** Rank test: how far the points spread from a point, then a line, then a plane. */
export function flatness(positions: ArrayLike<number>): { problem: SanityProblem | null; thickness: number } {
  const count = Math.floor(positions.length / 3);
  const at = (i: number, a: number): number => positions[i * 3 + a]!;
  const { size } = extents(positions);
  const tolerance = Math.hypot(size[0], size[1], size[2]) * 1e-6;

  let far = 0;
  let best = -1;
  for (let i = 0; i < count; i++) {
    const dist = Math.hypot(at(i, 0) - at(0, 0), at(i, 1) - at(0, 1), at(i, 2) - at(0, 2));
    if (dist > best) {
      best = dist;
      far = i;
    }
  }
  if (!(best > 0)) return { problem: 'coincident', thickness: 0 };

  const dx = (at(far, 0) - at(0, 0)) / best;
  const dy = (at(far, 1) - at(0, 1)) / best;
  const dz = (at(far, 2) - at(0, 2)) / best;
  let third = 0;
  best = -1;
  for (let i = 0; i < count; i++) {
    const wx = at(i, 0) - at(0, 0);
    const wy = at(i, 1) - at(0, 1);
    const wz = at(i, 2) - at(0, 2);
    const dist = Math.hypot(wy * dz - wz * dy, wz * dx - wx * dz, wx * dy - wy * dx);
    if (dist > best) {
      best = dist;
      third = i;
    }
  }
  if (best <= tolerance) return { problem: 'collinear', thickness: 0 };

  const ux = at(far, 0) - at(0, 0);
  const uy = at(far, 1) - at(0, 1);
  const uz = at(far, 2) - at(0, 2);
  const vx = at(third, 0) - at(0, 0);
  const vy = at(third, 1) - at(0, 1);
  const vz = at(third, 2) - at(0, 2);
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < count; i++) {
    const d = ((at(i, 0) - at(0, 0)) * nx + (at(i, 1) - at(0, 1)) * ny + (at(i, 2) - at(0, 2)) * nz) / len;
    if (d < low) low = d;
    if (d > high) high = d;
  }
  const thickness = high - low;
  return { problem: thickness <= tolerance ? 'coplanar' : null, thickness };
}

/** The first cheap check. Reports the first problem found and never throws. */
export function checkSanity(positions: ArrayLike<number>, indices?: ArrayLike<number>): SanityResult {
  const vertex_count = Math.floor(positions.length / 3);
  const non_finite_values = countNonFinite(positions);
  const fail = (problem: SanityProblem): SanityResult => ({ ok: false, problem, vertex_count, non_finite_values, thickness: 0 });
  if (non_finite_values > 0) return fail('not_finite');
  if (vertex_count < 4) return fail('too_few_vertices');
  if (indices) {
    for (let i = 0; i < indices.length; i++) {
      const v = indices[i]!;
      if (!Number.isInteger(v) || v < 0 || v >= vertex_count) return fail('bad_index');
    }
  }
  const flat = flatness(positions);
  if (flat.problem) return fail(flat.problem);
  return { ok: true, problem: null, vertex_count, non_finite_values, thickness: flat.thickness };
}

/** Width of the points along a horizontal axis. Yaw 0 is +x; positive yaw turns the axis toward +y. */
export function widthAtYaw(positions: ArrayLike<number>, yawDeg: number): number {
  const angle = (yawDeg * Math.PI) / 180;
  const cx = Math.cos(angle);
  const cy = Math.sin(angle);
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const d = positions[i]! * cx + positions[i + 1]! * cy;
    if (d < low) low = d;
    if (d > high) high = d;
  }
  return high - low;
}

export interface YawWidth {
  yaw_deg: number;
  width: number;
}

/** Width at every yaw step over a half turn, narrowest first. Ties keep the lower yaw. */
export function sweepYaw(positions: ArrayLike<number>, stepDeg: number = YAW_STEP_DEG): YawWidth[] {
  const out: YawWidth[] = [];
  for (let yaw = 0; yaw < 180; yaw += stepDeg) out.push({ yaw_deg: yaw, width: widthAtYaw(positions, yaw) });
  return out.sort((a, b) => a.width - b.width || a.yaw_deg - b.yaw_deg);
}

/** Width of the hull's cross-section at height z, along the yaw axis. Zero if z misses the hull. */
export function hullWidthAtHeight(hull: ConvexHull, yawDeg: number, z: number): number {
  const angle = (yawDeg * Math.PI) / 180;
  const cx = Math.cos(angle);
  const cy = Math.sin(angle);
  const p = hull.points;
  let low = Infinity;
  let high = -Infinity;
  const add = (x: number, y: number): void => {
    const d = x * cx + y * cy;
    if (d < low) low = d;
    if (d > high) high = d;
  };
  const edge = (a: number, b: number): void => {
    const za = p[a * 3 + 2]!;
    const zb = p[b * 3 + 2]!;
    if ((za - z) * (zb - z) > 0) return;
    if (za === zb) {
      add(p[a * 3]!, p[a * 3 + 1]!);
      add(p[b * 3]!, p[b * 3 + 1]!);
      return;
    }
    const t = (z - za) / (zb - za);
    add(p[a * 3]! + (p[b * 3]! - p[a * 3]!) * t, p[a * 3 + 1]! + (p[b * 3 + 1]! - p[a * 3 + 1]!) * t);
  };
  for (let f = 0; f < hull.faces.length; f += 3) {
    const a = hull.faces[f]!;
    const b = hull.faces[f + 1]!;
    const c = hull.faces[f + 2]!;
    edge(a, b);
    edge(b, c);
    edge(c, a);
  }
  return high >= low ? high - low : 0;
}

/**
 * How much more volume the hull holds than the mesh, as a percent of the mesh's own volume.
 * Null when the mesh has no usable volume, such as an open sheet.
 */
export function hullFillPercent(hullVolume: number, positions: ArrayLike<number>, indices: ArrayLike<number>): number | null {
  if (indices.length < 12) return null;
  const meshVolume = closedVolume(positions, indices);
  if (!(meshVolume > 0)) return null;
  return Math.max(0, (hullVolume / meshVolume - 1) * 100);
}

/** Copy of the points with a uniform scale and shift applied. */
export function transformPoints(points: ArrayLike<number>, scale: number, shift: readonly [number, number, number] = [0, 0, 0]): Float64Array {
  const out = new Float64Array(points.length);
  for (let i = 0; i < points.length; i++) out[i] = points[i]! * scale + shift[i % 3]!;
  return out;
}

/**
 * How far off square the jaw pads must meet the hull, in degrees, at one yaw. The pads close
 * along the yaw axis and touch the hull in the height band [zLow, zHigh]. For each pad, take
 * the hull faces that reach the pad (within touchTol of the hull's extreme along the axis in
 * the band, facing the pad) and the one closest to square with the axis: the pad can settle
 * on that face. The answer is the worse of the two pads. A two-finger grip holds only if the
 * friction cone covers this angle (mu at least its tangent): past it, squeezing pushes the
 * object out. Null if the band misses the hull.
 */
export function gripFaceAngleDeg(hull: ConvexHull, yawDeg: number, zLow: number, zHigh: number, touchTol: number): number | null {
  const angle = (yawDeg * Math.PI) / 180;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const p = hull.points;
  const f = hull.faces;
  const reach: { normal: [number, number, number]; along: [number, number] }[] = [];
  const best: [number, number] = [-Infinity, -Infinity];
  for (let t = 0; t < f.length; t += 3) {
    const v = [f[t]!, f[t + 1]!, f[t + 2]!].map((i) => [p[3 * i]!, p[3 * i + 1]!, p[3 * i + 2]!] as const);
    // The part of the triangle inside the band: its corners there, and where its edges cross the band's edges.
    const inside: (readonly [number, number, number])[] = v.filter((q) => q[2] >= zLow && q[2] <= zHigh);
    for (const [i, j] of [[0, 1], [1, 2], [2, 0]] as const) {
      for (const z of [zLow, zHigh]) {
        const za = v[i]![2];
        const zb = v[j]![2];
        if ((za - z) * (zb - z) < 0) {
          const s = (z - za) / (zb - za);
          inside.push([v[i]![0] + (v[j]![0] - v[i]![0]) * s, v[i]![1] + (v[j]![1] - v[i]![1]) * s, z]);
        }
      }
    }
    if (inside.length === 0) continue;
    const e1 = [v[1]![0] - v[0]![0], v[1]![1] - v[0]![1], v[1]![2] - v[0]![2]];
    const e2 = [v[2]![0] - v[0]![0], v[2]![1] - v[0]![1], v[2]![2] - v[0]![2]];
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const length = Math.hypot(n[0]!, n[1]!, n[2]!);
    if (!(length > 0)) continue;
    const along: [number, number] = [-Infinity, -Infinity];
    for (const q of inside) {
      const d = q[0] * ux + q[1] * uy;
      along[0] = Math.max(along[0], d);
      along[1] = Math.max(along[1], -d);
    }
    best[0] = Math.max(best[0], along[0]);
    best[1] = Math.max(best[1], along[1]);
    reach.push({ normal: [n[0]! / length, n[1]! / length, n[2]! / length], along });
  }
  if (reach.length === 0) return null;
  let worst = 0;
  for (const side of [0, 1] as const) {
    const sign = side === 0 ? 1 : -1;
    let squarest = 90;
    for (const face of reach) {
      if (face.along[side] < best[side] - touchTol) continue;
      const cos = sign * (face.normal[0] * ux + face.normal[1] * uy);
      if (cos <= 0) continue;
      squarest = Math.min(squarest, (Math.acos(Math.min(1, cos)) * 180) / Math.PI);
    }
    worst = Math.max(worst, squarest);
  }
  return worst;
}
