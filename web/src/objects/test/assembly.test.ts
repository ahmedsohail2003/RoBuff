// Objects from parts: the spec, the per-part meshes, the multi-geom MJCF in real MuJoCo, and
// the spoken lines that name them.
import loadMujoco, { type MainModule } from '@mujoco/mujoco';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildAssemblyParts, mergeParts } from '../generate/assembly';
import { generateMesh } from '../generate/index';
import { extents } from '../geometry';
import { validate } from '../guardrail';
import { closedVolume } from '../hull';
import { GRAVITY } from '../limits';
import { mentionsJaw, VoiceComposer } from '../messages';
import { toMjcf } from '../mjcf';
import { specFromText } from '../mock';
import type { Receipt } from '../receipt';
import { settle, settleSceneXml } from '../settle';
import { normalizeSpec, OBJECT_SPEC_SCHEMA } from '../spec';
import { AK47 } from './assemblyFixtures';
import { sameBytes, spec } from './helpers';

/** Every edge, matched by vertex position, is shared by exactly two triangles: the part is closed. */
function isClosed(positions: Float32Array, indices: Uint32Array): boolean {
  const key = (i: number) => `${positions[3 * i]},${positions[3 * i + 1]},${positions[3 * i + 2]}`;
  const edges = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3) {
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]] as const) {
      const ka = key(indices[t + a]!);
      const kb = key(indices[t + b]!);
      if (ka === kb) continue;
      const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  return [...edges.values()].every((n) => n === 2);
}

let mj: MainModule;
beforeAll(async () => {
  mj = await loadMujoco();
});

describe('assembly spec', () => {
  it('normalizes parts: keeps up to 8, fills rot_deg, falls back to one box without parts, and thickens slivers', () => {
    const many = normalizeSpec({ ...AK47, parts: Array.from({ length: 11 }, (_, i) => ({ ...AK47.parts![0]!, name: `p${i}` })) });
    expect(many.spec.parts).toHaveLength(8);
    expect(many.clamps.some((c) => c.includes('at most 8'))).toBe(true);
    const noRot = normalizeSpec({ ...AK47, parts: [{ name: 'a', shape: 'box', size_mm: [10, 10, 10], pos_mm: [0, 0, 0], color: '#ff0000' }] });
    expect(noRot.spec.parts![0]!.rot_deg).toEqual([0, 0, 0]);
    expect(noRot.clamps).toEqual([]);
    const none = normalizeSpec({ ...AK47, parts: [] });
    expect(none.spec.kind).toBe('box');
    expect(none.spec.parts).toBeUndefined();
    const sliver = normalizeSpec({ ...AK47, parts: [{ name: 'wing', shape: 'box', size_mm: [6000, 36000, 10], pos_mm: [0, 0, 0], color: '#cccccc' }] });
    expect(sliver.spec.parts![0]!.size_mm[2]).toBeCloseTo((2 * 18000) / 150, 6);
    // A plain spec gains no optional fields, so old specs stay byte-identical.
    expect(Object.keys(normalizeSpec(spec()).spec)).not.toContain('parts');
    expect(OBJECT_SPEC_SCHEMA.properties.parts.items.properties.shape.enum).toEqual(['box', 'cylinder', 'sphere', 'cone']);
  });

  it('a single box takes depth_mm, so it is no longer forced square', () => {
    const brick = generateMesh(spec({ kind: 'box', width_mm: 60, depth_mm: 25, height_mm: 20 }));
    const size = extents(brick.positions).size.map((v) => v * 1000);
    expect(size[0]).toBeCloseTo(60, 3);
    expect(size[1]).toBeCloseTo(25, 3);
    expect(size[2]).toBeCloseTo(20, 3);
  });
});

describe('assembly meshes', () => {
  it('(a) every part is a closed, finite mesh; same seed same bytes; another seed other bytes', () => {
    const parts = buildAssemblyParts(AK47);
    expect(parts.map((p) => p.name)).toEqual(['stock', 'receiver', 'barrel', 'magazine', 'grip']);
    for (const part of parts) {
      expect(part.mesh.positions.every(Number.isFinite), part.name).toBe(true);
      expect(part.mesh.normals.every(Number.isFinite), part.name).toBe(true);
      expect(isClosed(part.mesh.positions, part.mesh.indices), part.name).toBe(true);
      const volume = closedVolume(part.mesh.positions, part.mesh.indices);
      expect(volume, part.name).toBeGreaterThan(0);
      // Parts are convex, so the hull holds the same volume as the mesh (within float rounding).
      expect(Math.abs(part.hull.volume / volume - 1), part.name).toBeLessThan(0.01);
    }
    const merged = mergeParts(parts);
    expect(merged.colors!.length).toBe(merged.positions.length);
    // Each part's colour is on its own vertices: the stock's first vertex is wood brown.
    expect(Array.from(merged.colors!.slice(0, 3)).map((c) => Math.round(c * 255))).toEqual([0x8b, 0x5a, 0x2b]);
    const again = generateMesh(AK47);
    expect(sameBytes(generateMesh(AK47).positions, again.positions)).toBe(true);
    expect(sameBytes(generateMesh({ ...AK47, seed: 48 }).positions, again.positions)).toBe(false);
    // Turned parts land where asked: the barrel runs along x in front of the receiver.
    const barrel = extents(parts[2]!.mesh.positions);
    expect(barrel.size[0] * 1000).toBeCloseTo(400, 0);
    expect(barrel.min[0] * 1000).toBeGreaterThan(120);
  });

  it('the guardrail sizes the union, keeps every part, and names the model scale', () => {
    const r = validate(AK47);
    console.log(`AK47 guardrail: ${r.steps.map((s) => `${s.code}:${s.action}`).join(' ')} size ${r.size_mm!.map((v) => v.toFixed(1)).join(' x ')} mm, ${(r.mass_kg! * 1000).toFixed(2)} g`);
    console.log(`AK47 PARTS: ${r.steps.find((s) => s.code === 'PARTS')!.message}`);
    expect(r.verdict).toBe('READY_FOR_LIFT_TEST');
    expect(r.parts).toHaveLength(5);
    expect(r.steps.find((s) => s.code === 'PARTS')!.message).toMatch(/^Built from 5 parts: stock, receiver, barrel, magazine, grip\..* A 1:[\d.]+ (toy )?model, \d+ mm long\.$/);
    // The receipt mass is the sum of the parts.
    const sum = r.parts!.reduce((m, p) => m + p.mass_kg, 0);
    expect(r.mass_kg).toBe(sum);
    // The size fits the arm: length at most 150 mm, height at most 60.
    expect(Math.max(r.size_mm![0], r.size_mm![1])).toBeLessThanOrEqual(150.01);
    expect(r.size_mm![2]).toBeLessThanOrEqual(60);
  });
});

describe('assembly MJCF in real MuJoCo WASM (Node)', () => {
  it('(b) one mesh geom per part, maxhullvert 64, explicit masses; the compiled mass equals the receipt mass within 0.1 percent', () => {
    const rows: string[] = [];
    for (const [label, s] of [
      ['AK-47', AK47],
      ['car (offline)', specFromText('a tesla').spec],
      ['plane (offline)', specFromText('a plane').spec],
      ['mug (offline)', specFromText('a coffee mug').spec],
    ] as const) {
      const r = validate(s);
      expect(r.parts, label).toBeDefined();
      const fragment = toMjcf(r);
      expect(fragment.names.parts).toHaveLength(r.parts!.length);
      expect((fragment.asset.match(/maxhullvert="64"/g) ?? []).length).toBe(r.parts!.length);
      const model = mj.MjModel.from_xml_string(settleSceneXml([fragment], GRAVITY.earth));
      const geoms = Array.from(model.geom_bodyid as Int32Array).filter((b) => b === 1).length;
      const compiled = (model.body_mass as Float64Array)[1]!;
      rows.push(`${label}: ${geoms} geoms, receipt ${(r.mass_kg! * 1000).toFixed(4)} g, compiled ${(compiled * 1000).toFixed(4)} g, ratio ${(compiled / r.mass_kg!).toFixed(6)}`);
      expect(geoms, label).toBe(r.parts!.length);
      expect(Math.abs(compiled / r.mass_kg! - 1), label).toBeLessThan(0.001);
      model.delete();
      // It settles on a plane with finite state.
      const report = settle(mj, r, { fixed_steps: 500 });
      expect(report.finite, label).toBe(true);
      expect(report.touched, label).toBe(true);
      expect(Math.abs(report.model_mass_kg / r.mass_kg! - 1), label).toBeLessThan(0.001);
    }
    console.log(rows.join('\n'));
  });
});

describe('spoken lines', () => {
  const at = (kind: Partial<Receipt>, base: Receipt): Receipt => ({ ...base, ...kind });

  it('(d) six receipts in a row: no identical consecutive lines, at least four phrasings, the jaw limit said at most once outside width refusals', () => {
    const voice = new VoiceComposer();
    const ak = at({ verdict: 'ADJUSTED' }, validate(AK47));
    const car = at({ verdict: 'ADJUSTED' }, validate(specFromText('a tesla').spec));
    const mug = at({ verdict: 'ADJUSTED' }, validate(specFromText('a coffee mug').spec));
    const box = at({ verdict: 'PASS' }, validate(spec({ kind: 'box', width_mm: 40, height_mm: 30, material: 'aluminium', name: 'grass block' })));
    const lines = [ak, ak, car, mug, box, ak].map((r) => voice.compose(r, true));
    for (const line of lines) console.log(`spoken: ${line.text}`);
    for (let i = 1; i < lines.length; i++) expect(lines[i]!.text).not.toBe(lines[i - 1]!.text);
    expect(lines.filter((l) => mentionsJaw(l.text)).length).toBeLessThanOrEqual(1);
    expect(lines[0]!.text).toContain('AK-47');
    expect(lines[2]!.text).toContain('car');
    expect(lines[4]!.text).toContain('grass block');
    // Four or more different openings across the six.
    expect(new Set(lines.map((l) => l.text.split(' ').slice(0, 2).join(' '))).size).toBeGreaterThanOrEqual(4);
    // The caption contract e2e/s7-voice-offline.spec.ts checks: a lift line names the simulated lift test.
    expect(lines.every((l) => l.kind === 'receipt' && /simulated lift test/.test(l.text))).toBe(true);

    // A width refusal may name the jaw again; the same refusal twice is not said identically.
    const thin = validate(spec({ kind: 'fragment', width_mm: 2, height_mm: 2000, name: 'needle' }));
    expect(thin.verdict).toBe('REFUSED');
    const r1 = voice.compose(thin, false);
    const r2 = voice.compose(thin, false);
    console.log(`refusal: ${r1.text}`);
    expect(r1.kind).toBe('refusal');
    expect(r1.text).not.toBe(r2.text);
    expect(mentionsJaw(r1.text)).toBe(true);
    // Every refusal phrasing says the verdict word, so the caption reads as a refusal (s7 checks /Refused/).
    const refusals = [r1, r2, voice.compose(thin, false), voice.compose(thin, false), voice.compose(thin, false)];
    for (const r of refusals) expect(r.text, r.text).toMatch(/^Refused[:.]/);
    expect(new Set(refusals.slice(0, 4).map((r) => r.text)).size).toBe(4);
  });
});
