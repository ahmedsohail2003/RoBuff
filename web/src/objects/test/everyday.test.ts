// The everyday kinds (box, cylinder, sphere, cone): closed finite meshes at the asked size,
// deterministic per seed, through the same guardrail as the space kinds, and the mock finds them.
import { describe, expect, it } from 'vitest';
import { generateMesh } from '../generate/index';
import { extents } from '../geometry';
import { validate } from '../guardrail';
import { closedVolume, convexHull } from '../hull';
import { specFromText } from '../mock';
import type { ObjectKind } from '../spec';
import { sameBytes, spec } from './helpers';

const EVERYDAY: readonly ObjectKind[] = ['box', 'cylinder', 'sphere', 'cone'];

describe('everyday kinds', () => {
  for (const kind of EVERYDAY) {
    it(`${kind}: finite, closed, outward, at the asked width and height`, () => {
      for (const [w, h] of [
        [40, 40],
        [36, 52],
        [50, 20],
      ] as const) {
        const mesh = generateMesh(spec({ kind, seed: 9, width_mm: w, height_mm: h, color: '#4f9a3a' }));
        expect(mesh.positions.every(Number.isFinite), kind).toBe(true);
        expect(mesh.normals.every(Number.isFinite), kind).toBe(true);
        expect(closedVolume(mesh.positions, mesh.indices), kind).toBeGreaterThan(0);
        const size = extents(mesh.positions).size;
        expect(size[0] * 1000).toBeCloseTo(w, 3);
        expect(size[1] * 1000).toBeCloseTo(w, 3);
        expect(size[2] * 1000).toBeCloseTo(h, 3);
        // Near-convex: the mesh fills most of its own hull.
        const fill = closedVolume(mesh.positions, mesh.indices) / convexHull(mesh.positions)!.volume;
        expect(fill, kind).toBeGreaterThan(0.97);
      }
    });

    it(`${kind}: same seed same bytes, other seed other bytes`, () => {
      const a = generateMesh(spec({ kind, seed: 5, width_mm: 40, height_mm: 40 }));
      const again = generateMesh(spec({ kind, seed: 5, width_mm: 40, height_mm: 40 }));
      const other = generateMesh(spec({ kind, seed: 6, width_mm: 40, height_mm: 40 }));
      expect(sameBytes(a.positions, again.positions)).toBe(true);
      expect(sameBytes(a.indices, again.indices)).toBe(true);
      expect(sameBytes(a.positions, other.positions)).toBe(false);
    });

    it(`${kind}: the guardrail readies a 40 mm one for the lift test and keeps the colour`, () => {
      const r = validate(spec({ kind, width_mm: 40, height_mm: 40, material: 'c_type_rock', color: '#4f9a3a' }));
      const refused = r.steps.find((s) => s.action === 'refused');
      expect(refused?.message ?? 'none', kind).toBe('none');
      expect(r.verdict, kind).toBe('READY_FOR_LIFT_TEST');
      expect(r.spec.color).toBe('#4f9a3a');
      expect(r.steps.map((s) => s.code)).toEqual(expect.arrayContaining(['SANITY_OK', 'HULL_OK', 'SCALE_OK', 'MASS_OK', 'FRICTION_OK', 'GRIP_OK']));
    });
  }

  it('a box with lumpiness 0 is nearly sharp: it fills almost all of its bounding box', () => {
    const mesh = generateMesh(spec({ kind: 'box', lumpiness: 0, width_mm: 40, height_mm: 40 }));
    expect(closedVolume(mesh.positions, mesh.indices) / 0.04 ** 3).toBeGreaterThan(0.97);
  });

  it('the offline mock maps everyday words to everyday kinds, and colour words to colours', () => {
    expect(specFromText('Minecraft grass block').spec).toMatchObject({ kind: 'box', color: '#4f9a3a' });
    expect(specFromText('a cube').spec.kind).toBe('box');
    expect(specFromText('a soda can').spec.kind).toBe('cylinder');
    expect(specFromText('a tennis ball').spec.kind).toBe('sphere');
    expect(specFromText('an orange traffic cone').spec.kind).toBe('cone');
    expect(specFromText('a bennu rock').spec.kind).toBe('asteroid');
    expect(specFromText('can you make a rock').spec.kind).toBe('asteroid');
  });
});
