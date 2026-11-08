import { describe, expect, it } from 'vitest';
import { generateMesh } from '../generate/index';
import { closedVolume, convexHull } from '../hull';
import { extents } from '../geometry';
import { KINDS } from '../spec';
import { sameBytes, spec } from './helpers';

describe('procedural meshes', () => {
  it('(a) 200 asteroid seeds: finite, real hull volume, same seed same bytes, different seeds different bytes', () => {
    const fingerprints = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      const s = spec({ seed, roughness: (seed % 5) / 4, lumpiness: ((seed * 3) % 5) / 4 });
      const mesh = generateMesh(s);
      expect(mesh.positions.length).toBe(642 * 3);
      expect(mesh.indices.length).toBe(1280 * 3);
      expect(mesh.positions.every(Number.isFinite)).toBe(true);
      expect(mesh.normals.every(Number.isFinite)).toBe(true);
      const hull = convexHull(mesh.positions);
      expect(hull).not.toBeNull();
      expect(hull!.volume).toBeGreaterThan(0);

      const again = generateMesh(s);
      expect(sameBytes(mesh.positions, again.positions)).toBe(true);
      expect(sameBytes(mesh.indices, again.indices)).toBe(true);
      expect(sameBytes(mesh.normals, again.normals)).toBe(true);
      fingerprints.add(Buffer.from(mesh.positions.buffer).toString('base64'));
    }
    expect(fingerprints.size).toBe(200);
  });

  it('every kind is deterministic and seed-sensitive across 200 seeds', () => {
    for (const kind of KINDS) {
      const seen = new Set<string>();
      for (let seed = 0; seed < 200; seed++) {
        const s = spec({ kind, seed, width_mm: 48, height_mm: kind === 'panel' ? 10 : 30 });
        const mesh = generateMesh(s);
        expect(mesh.positions.every(Number.isFinite)).toBe(true);
        expect(convexHull(mesh.positions)!.volume).toBeGreaterThan(0);
        expect(sameBytes(mesh.positions, generateMesh(s).positions)).toBe(true);
        seen.add(Buffer.from(mesh.positions.buffer).toString('base64'));
      }
      expect(seen.size, kind).toBe(200);
    }
    // 2,200 meshes and hulls (ten kinds): about 3 s alone, but 19 s measured with other test runs on the machine, so a wide margin.
  }, 120_000);

  it('meshes are closed and wound outward, at the requested width and height', () => {
    for (const kind of KINDS) {
      for (const seed of [1, 2, 3]) {
        const mesh = generateMesh(spec({ kind, seed, width_mm: 50, height_mm: 24 }));
        expect(closedVolume(mesh.positions, mesh.indices), kind).toBeGreaterThan(0);
        const size = extents(mesh.positions).size;
        expect(size[0] * 1000).toBeCloseTo(50, 3);
        expect(size[2] * 1000).toBeCloseTo(24, 3);
      }
    }
  });

  it('asteroids are lumpy rocks, not spiky balls: neighbouring vertices never jump far in radius', () => {
    let worstSlope = 0;
    for (let seed = 0; seed < 50; seed++) {
      const mesh = generateMesh(spec({ seed, roughness: 1, lumpiness: 1, width_mm: 40, height_mm: 40 }));
      const p = mesh.positions;
      const radius = (i: number): number => Math.hypot(p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!);
      for (let t = 0; t < mesh.indices.length; t += 3) {
        for (const [a, b] of [[0, 1], [1, 2], [2, 0]] as const) {
          const i = mesh.indices[t + a]!;
          const j = mesh.indices[t + b]!;
          const edge = Math.hypot(p[i * 3]! - p[j * 3]!, p[i * 3 + 1]! - p[j * 3 + 1]!, p[i * 3 + 2]! - p[j * 3 + 2]!);
          worstSlope = Math.max(worstSlope, Math.abs(radius(i) - radius(j)) / edge);
        }
      }
    }
    // A slope of 1 is a 45 degree step between neighbours. Spikes would need far more.
    expect(worstSlope).toBeLessThan(1);
  });
});
