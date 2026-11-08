// Skin mapping: part ranges, de-indexing and box-projected UVs on real validated objects.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validate } from '../guardrail';
import { specFromText } from '../mock';
import type { Receipt } from '../receipt';
import { anchorOf, boxUv, deindex, displayName, matchParts, partRanges, singular } from '../skinUv';
import { AK47 } from './assemblyFixtures';
import { spec } from './helpers';

const car = validate(specFromText('a tesla').spec);
const ak = validate(AK47);
const singles: Receipt[] = [
  validate(spec({ kind: 'box', width_mm: 50, depth_mm: 40, height_mm: 30, material: 'aluminium' })),
  validate(spec({ kind: 'cylinder', width_mm: 40, height_mm: 60, material: 'iron' })),
  validate(spec({ kind: 'sphere', width_mm: 50, height_mm: 50 })),
  validate(spec({ kind: 'asteroid', width_mm: 50, height_mm: 40, seed: 3 })),
  validate(spec({ kind: 'cone', width_mm: 40, height_mm: 50 })),
];

/** UVs for a whole object the way the skin layer makes them: fitted to the object, or to each part. */
function uvsFor(receipt: Receipt, perPart: boolean): { flat: ReturnType<typeof deindex>; uv: Float32Array } {
  const flat = deindex(receipt.mesh!);
  const uv = new Float32Array((flat.positions.length / 3) * 2).fill(Number.NaN);
  const ranges = partRanges(receipt);
  const whole = anchorOf(flat.positions, 0, flat.indices.length);
  for (const r of ranges) boxUv(flat.positions, uv, r.start, r.count, perPart ? anchorOf(flat.positions, r.start, r.count) : whole);
  return { flat, uv };
}

describe('skin mapping', () => {
  it('the offline Tesla is a six-part car, as the e2e expects', () => {
    expect(car.verdict).not.toBe('REFUSED');
    expect(displayName(car)).toBe('car');
    expect(car.parts!.map((p) => p.name)).toEqual(['body', 'cabin', 'front left wheel', 'front right wheel', 'rear left wheel', 'rear right wheel']);
  });

  it('partRanges sum to the index count and follow the part order', () => {
    for (const r of [car, ak, ...singles]) {
      const ranges = partRanges(r);
      expect(ranges.reduce((n, x) => n + x.count, 0)).toBe(r.mesh!.indices.length);
      let start = 0;
      for (const x of ranges) {
        expect(x.start).toBe(start);
        expect(x.count % 3).toBe(0);
        start += x.count;
      }
    }
    expect(partRanges(ak).map((x) => x.name)).toEqual(['stock', 'receiver', 'barrel', 'magazine', 'grip']);
    expect(partRanges(ak).map((x) => x.count)).toEqual(ak.parts!.map((p) => p.mesh.indices.length));
    expect(partRanges(singles[1]!)).toEqual([{ index: 0, name: 'cylinder', start: 0, count: singles[1]!.mesh!.indices.length }]);
  });

  it('deindex keeps the triangle count, the corner positions and the colours, with an identity index and unit normals', () => {
    for (const r of [car, ak, ...singles]) {
      const mesh = r.mesh!;
      const flat = deindex(mesh);
      expect(flat.indices.length).toBe(mesh.indices.length);
      expect(flat.positions.length).toBe(mesh.indices.length * 3);
      for (let i = 0; i < flat.indices.length; i++) expect(flat.indices[i]).toBe(i);
      for (let i = 0; i < mesh.indices.length; i += 97) {
        const v = mesh.indices[i]!;
        expect([flat.positions[3 * i], flat.positions[3 * i + 1], flat.positions[3 * i + 2]]).toEqual([mesh.positions[3 * v], mesh.positions[3 * v + 1], mesh.positions[3 * v + 2]]);
        if (mesh.colors) expect(flat.colors![3 * i]).toBe(mesh.colors[3 * v]);
      }
      for (let i = 0; i < flat.normals.length; i += 3 * 31) expect(Math.hypot(flat.normals[i]!, flat.normals[i + 1]!, flat.normals[i + 2]!)).toBeCloseTo(1, 3);
      expect(flat.colors === undefined).toBe(mesh.colors === undefined);
    }
  });

  it('every vertex of every object gets finite UVs in [0, 1], fitted to the object and to each part', () => {
    for (const r of [car, ak, ...singles]) {
      for (const perPart of [false, true]) {
        const { uv } = uvsFor(r, perPart);
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = 0; i < uv.length; i++) {
          expect(Number.isFinite(uv[i]!)).toBe(true);
          lo = Math.min(lo, uv[i]!);
          hi = Math.max(hi, uv[i]!);
        }
        expect(lo).toBeGreaterThanOrEqual(0);
        expect(hi).toBeLessThanOrEqual(1);
        // The fit uses most of the image, not a corner of it. A ball's six caps each cover
        // sin 45 deg = 0.71 of its box, the least of any shape.
        expect(hi - lo, `${displayName(r)} perPart=${perPart}`).toBeGreaterThan(0.7);
      }
    }
  });

  it('box faces are not mirrored: on a +X face u grows with +y, on +Z u grows with +x, and v is up on the sides', () => {
    const box = singles[0]!;
    const { flat, uv } = uvsFor(box, false);
    let checkedX = 0;
    let checkedZ = 0;
    for (let t = 0; t < flat.indices.length; t += 3) {
      const n = [flat.normals[3 * t]!, flat.normals[3 * t + 1]!, flat.normals[3 * t + 2]!];
      const p = (c: number, a: number) => flat.positions[3 * (t + c) + a]!;
      const u = (c: number) => uv[2 * (t + c)]!;
      const v = (c: number) => uv[2 * (t + c) + 1]!;
      for (const [c1, c2] of [[0, 1], [1, 2], [0, 2]] as const) {
        if (n[0]! > 0.99 && Math.abs(p(c1, 1) - p(c2, 1)) > 1e-4) {
          expect(Math.sign(u(c1) - u(c2))).toBe(Math.sign(p(c1, 1) - p(c2, 1)));
          checkedX++;
        }
        if (n[0]! > 0.99 && Math.abs(p(c1, 2) - p(c2, 2)) > 1e-4) expect(Math.sign(v(c1) - v(c2))).toBe(Math.sign(p(c1, 2) - p(c2, 2)));
        if (n[2]! > 0.99 && Math.abs(p(c1, 0) - p(c2, 0)) > 1e-4) {
          expect(Math.sign(u(c1) - u(c2))).toBe(Math.sign(p(c1, 0) - p(c2, 0)));
          checkedZ++;
        }
      }
    }
    expect(checkedX).toBeGreaterThan(0);
    expect(checkedZ).toBeGreaterThan(0);
  });

  it('fitted to its own box, each wheel is centred on the image, so four wheels look alike', () => {
    const { flat, uv } = uvsFor(car, true);
    for (const r of partRanges(car).filter((x) => x.name.endsWith('wheel'))) {
      let su = 0;
      let sv = 0;
      for (let i = r.start; i < r.start + r.count; i++) {
        su += uv[2 * i]!;
        sv += uv[2 * i + 1]!;
      }
      expect(su / r.count).toBeCloseTo(0.5, 1);
      expect(sv / r.count).toBeCloseTo(0.5, 1);
      void flat;
    }
  });

  it('matchParts: "wheels" picks all four wheels of the car; names, plurals, words and substrings', () => {
    const names = car.parts!.map((p) => p.name);
    expect(matchParts(names, 'wheels')).toEqual([2, 3, 4, 5]);
    expect(matchParts(names, 'the wheels')).toEqual([2, 3, 4, 5]);
    expect(matchParts(names, 'wheel')).toEqual([2, 3, 4, 5]);
    expect(matchParts(names, 'front left wheel')).toEqual([2]);
    expect(matchParts(names, 'front wheels')).toEqual([2, 3]);
    expect(matchParts(names, 'rear wheels')).toEqual([4, 5]);
    expect(matchParts(names, 'body')).toEqual([0]);
    expect(matchParts(names, 'the cabin')).toEqual([1]);
    expect(matchParts(names, 'spoiler')).toEqual([]);
    for (const all of [null, undefined, '', 'all', 'All parts', 'whole', 'everything', 'the whole thing', 'it']) expect(matchParts(names, all)).toEqual([0, 1, 2, 3, 4, 5]);
    const akNames = ak.parts!.map((p) => p.name);
    expect(matchParts(akNames, 'the barrel')).toEqual([2]);
    expect(matchParts(akNames, 'mag')).toEqual([3]);
    expect(matchParts(akNames, 'stocks')).toEqual([0]);
    expect(matchParts(['wheel', 'wheel', 'deck'], 'wheels')).toEqual([0, 1]);
    expect(singular('batteries')).toBe('battery');
    expect(singular('boxes')).toBe('box');
    expect(singular('glass')).toBe('glass');
  });

  it('displayName: the spec name, else a word for the kind; messages.ts uses the same helper', () => {
    expect(displayName(ak)).toBe('AK-47');
    expect(displayName(singles[2]!)).toBe('ball');
    expect(displayName(singles[3]!)).toBe('rock sample');
    const messages = readFileSync(new URL('../messages.ts', import.meta.url), 'utf8');
    expect(messages).toContain("import { displayName } from './skinUv'");
    expect(messages).not.toContain('KIND_NAMES');
  });

  it('render/objectSkin.ts imports nothing from sim/ or the MJCF: a skin is paint only', () => {
    const source = readFileSync(new URL('../../render/objectSkin.ts', import.meta.url), 'utf8');
    const imports = source.split('\n').filter((l) => l.startsWith('import'));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) {
      expect(line).not.toMatch(/sim\/|mjcf|guardrail|hull/);
    }
  });
});
