import { describe, expect, it } from 'vitest';
import { checkSanity, extents, gripFaceAngleDeg, hullFillPercent, hullWidthAtHeight, sweepYaw, widthAtYaw } from '../geometry';
import { convexHull } from '../hull';
import { generateMesh } from '../generate/index';
import { spec } from './helpers';

function box(x: number, y: number, z: number, extra = 0): Float32Array {
  const points: number[] = [];
  for (const a of [-x / 2, x / 2]) for (const b of [-y / 2, y / 2]) for (const c of [-z / 2, z / 2]) points.push(a, b, c);
  for (let i = 0; i < extra; i++) points.push(((i * 0.37) % 1 - 0.5) * x * 0.9, ((i * 0.61) % 1 - 0.5) * y * 0.9, ((i * 0.83) % 1 - 0.5) * z * 0.9);
  return Float32Array.from(points);
}

describe('geometry', () => {
  it('hull of a box with interior points is the box', () => {
    const hull = convexHull(box(0.04, 0.03, 0.02, 50))!;
    expect(hull.points.length / 3).toBe(8);
    expect(hull.volume).toBeCloseTo(0.04 * 0.03 * 0.02, 10);
  });

  it('hull contains every input point', () => {
    for (const kind of ['asteroid', 'dish', 'panel'] as const) {
      const mesh = generateMesh(spec({ kind, seed: 9 }));
      const hull = convexHull(mesh.positions)!;
      const p = hull.points;
      let worst = 0;
      for (let f = 0; f < hull.faces.length; f += 3) {
        const a = hull.faces[f]! * 3;
        const b = hull.faces[f + 1]! * 3;
        const c = hull.faces[f + 2]! * 3;
        const u = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
        const v = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
        const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
        const len = Math.hypot(n[0]!, n[1]!, n[2]!);
        if (len === 0) continue;
        for (let i = 0; i < mesh.positions.length; i += 3) {
          const d = ((mesh.positions[i]! - p[a]!) * n[0]! + (mesh.positions[i + 1]! - p[a + 1]!) * n[1]! + (mesh.positions[i + 2]! - p[a + 2]!) * n[2]!) / len;
          worst = Math.max(worst, d);
        }
      }
      expect(worst, kind).toBeLessThan(1e-7);
    }
  });

  it('width along a yaw, the sweep and extents', () => {
    const points = box(0.06, 0.02, 0.01);
    expect(widthAtYaw(points, 0)).toBeCloseTo(0.06, 7);
    expect(widthAtYaw(points, 90)).toBeCloseTo(0.02, 7);
    const sweep = sweepYaw(points);
    expect(sweep).toHaveLength(12);
    expect(sweep[0]!.yaw_deg).toBe(90);
    expect(extents(points).size[2]).toBeCloseTo(0.01, 7);
  });

  it('cross-section width at a height', () => {
    // A square pyramid, 40 mm base, 40 mm tall: half way up it is 20 mm across.
    const pyramid = Float32Array.from([-0.02, -0.02, 0, 0.02, -0.02, 0, 0.02, 0.02, 0, -0.02, 0.02, 0, 0, 0, 0.04]);
    const hull = convexHull(pyramid)!;
    expect(hullWidthAtHeight(hull, 0, 0.02)).toBeCloseTo(0.02, 7);
    expect(hullWidthAtHeight(hull, 0, 0.05)).toBe(0);
  });

  it('grip face angle: square faces give 0, sloped sides give their slope, a missed band gives null', () => {
    const cube = convexHull(box(0.02, 0.02, 0.02))!;
    expect(gripFaceAngleDeg(cube, 0, -0.005, 0.005, 0.001)).toBeCloseTo(0, 6);
    // A cube turned 45 degrees to the jaw meets the pads on its edges, whose faces sit 45 degrees off.
    expect(gripFaceAngleDeg(cube, 45, -0.005, 0.005, 0.001)).toBeCloseTo(45, 6);
    // A ridge: 20 mm wide at the floor, 10 mm at the top 10 mm up, so its x sides slope atan(5/10).
    const ridge: number[] = [];
    for (const y of [-0.01, 0.01]) ridge.push(-0.01, y, 0, 0.01, y, 0, -0.005, y, 0.01, 0.005, y, 0.01);
    const hull = convexHull(Float32Array.from(ridge))!;
    expect(gripFaceAngleDeg(hull, 0, 0.002, 0.01, 0.001)).toBeCloseTo((Math.atan(0.5) * 180) / Math.PI, 6);
    expect(gripFaceAngleDeg(hull, 90, 0.002, 0.01, 0.001)).toBeCloseTo(0, 6);
    expect(gripFaceAngleDeg(hull, 0, 0.02, 0.03, 0.001)).toBeNull();
  });

  it('hull-fill percent is zero for convex shapes and positive for a bowl', () => {
    const fragment = generateMesh(spec({ kind: 'fragment' }));
    expect(hullFillPercent(convexHull(fragment.positions)!.volume, fragment.positions, fragment.indices)).toBeLessThan(1e-6);
    const dish = generateMesh(spec({ kind: 'dish', width_mm: 50, height_mm: 20 }));
    expect(hullFillPercent(convexHull(dish.positions)!.volume, dish.positions, dish.indices)).toBeGreaterThan(5);
  });

  it('sanity finds NaN, too few vertices, coincident, collinear and flat clouds', () => {
    expect(checkSanity(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, Number.NaN])).problem).toBe('not_finite');
    expect(checkSanity(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0])).problem).toBe('too_few_vertices');
    expect(checkSanity(new Float32Array(12)).problem).toBe('coincident');
    expect(checkSanity(Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0])).problem).toBe('collinear');
    expect(checkSanity(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0.5, 0.5, 0])).problem).toBe('coplanar');
    expect(checkSanity(box(0.01, 0.01, 0.01)).ok).toBe(true);
    expect(convexHull(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]))).toBeNull();
  });
});
