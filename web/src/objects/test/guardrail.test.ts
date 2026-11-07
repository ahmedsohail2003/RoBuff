import { describe, expect, it } from 'vitest';
import { generateMesh } from '../generate/index';
import { extents } from '../geometry';
import { validate, validateMesh } from '../guardrail';
import { convexHull } from '../hull';
import { proveLift, type LiftRequest, type LiftTester } from '../lift';
import { GRAVITY, HAND_BAND, HARD_BAND, H_MAX } from '../limits';
import { LIFT_NOT_RUN_TEXT } from '../messages';
import { PRESETS } from '../mock';
import type { Receipt } from '../receipt';
import { KINDS } from '../spec';
import { spec } from './helpers';

const codes = (r: Receipt): string[] => r.steps.map((s) => s.code);
const stepOf = (r: Receipt, code: string) => r.steps.find((s) => s.code === code);

describe('guardrail pipeline', () => {
  it('runs its steps in the stated order', () => {
    const order = codes(validate(spec()));
    expect(order).toEqual(['SANITY_OK', 'HULL_OK', 'YAW_CHOSEN', 'SCALE_OK', 'MASS_OK', 'FRICTION_OK', 'GRIP_OK', 'LIFT_NOT_RUN']);
    for (const s of validate(spec()).steps) {
      expect(typeof s.ok).toBe('boolean');
      expect(s).toHaveProperty('measured');
      expect(s).toHaveProperty('limit');
      expect(typeof s.unit).toBe('string');
      expect(s.message.length).toBeGreaterThan(20);
    }
  });

  it('(b) each kind builds and reports hull-fill percent', () => {
    for (const kind of KINDS) {
      const r = validate(spec({ kind, width_mm: 45, height_mm: kind === 'panel' ? 10 : 28 }));
      expect(r.verdict, kind).toBe('READY_FOR_LIFT_TEST');
      expect(r.hull_fill_percent, kind).not.toBeNull();
      expect(r.hull_fill_percent!, kind).toBeGreaterThanOrEqual(0);
      console.log(`hull-fill ${kind}: ${r.hull_fill_percent!.toFixed(1)} percent`);
    }
    expect(validate(spec({ kind: 'dish', width_mm: 50, height_mm: 20 })).hull_fill_percent!).toBeGreaterThan(5);
  });

  it('(c) a Texas-sized request ends inside the band with proportions kept, and TOO_WIDE quotes size and limit', () => {
    const request = spec({ width_mm: 1_000_000, height_mm: 800_000 });
    const r = validate(request);
    const original = extents(generateMesh(request).positions).size;
    const final = extents(r.mesh!.positions).size;
    expect(r.narrow_width_mm!).toBeGreaterThanOrEqual(HAND_BAND.w_min * 1000);
    expect(r.narrow_width_mm!).toBeLessThanOrEqual(HAND_BAND.w_max * 1000);
    expect(final[2] * 1000).toBeLessThanOrEqual(H_MAX * 1000);
    for (const [a, b] of [[0, 1], [0, 2], [1, 2]] as const) {
      const before = original[a] / original[b];
      const after = final[a] / final[b];
      expect(Math.abs(after / before - 1)).toBeLessThan(0.01);
    }
    const tooWide = stepOf(r, 'TOO_WIDE')!;
    expect(tooWide.ok).toBe(false);
    expect(tooWide.action).toBe('rescaled');
    expect(tooWide.message).toContain('1,000,000 millimetres');
    expect(tooWide.message).toContain('70 millimetres');
    expect(tooWide.message).toContain('55');
    expect(tooWide.limit).toBe(55);
    expect(r.verdict).toBe('READY_FOR_LIFT_TEST');
    expect(r.adjusted).toBe(true);
    console.log(`Texas: ${tooWide.message}`);
  });

  it('(d) a needle, 2000 mm long and 2 mm thick, is REFUSED with NO_SINGLE_SCALE', () => {
    const standing = validate(spec({ kind: 'fragment', width_mm: 2, height_mm: 2000 }));
    expect(standing.verdict).toBe('REFUSED');
    expect(codes(standing)).toContain('NO_SINGLE_SCALE');
    expect(standing.mesh).toBeNull();
    console.log(`Needle: ${stepOf(standing, 'NO_SINGLE_SCALE')!.message}`);

    // The same needle lying down, as a raw mesh: 2000 x 2 x 2 mm.
    const points: number[] = [];
    for (const x of [-1, 1]) for (const y of [-0.001, 0.001]) for (const z of [-0.001, 0.001]) points.push(x, y, z);
    const lying = validateMesh({ positions: Float32Array.from(points), indices: new Uint32Array(0) }, spec({ material: 'aluminium' }));
    expect(lying.verdict).toBe('REFUSED');
    expect(codes(lying)).toContain('NO_SINGLE_SCALE');

    // A pancake fails the same way, from the other side.
    expect(codes(validate(spec({ width_mm: 2000, height_mm: 2 })))).toContain('NO_SINGLE_SCALE');
  });

  it('(e) solid iron at 60 mm is TOO_HEAVY, with mass within 5% of hull volume x 7.8 g/cc', () => {
    const r = validate(spec({ width_mm: 60, height_mm: 55, material: 'iron' }));
    const heavy = stepOf(r, 'TOO_HEAVY')!;
    expect(heavy).toBeDefined();
    expect(r.verdict).toBe('REFUSED');
    const independent = convexHull(r.mesh!.positions)!.volume * 7800;
    expect(Math.abs(r.mass_kg! / independent - 1)).toBeLessThan(0.05);
    expect(Math.abs(heavy.measured! / independent - 1)).toBeLessThan(0.05);
    expect(heavy.message).toMatch(/\d+ grams/);
    expect(heavy.message).toContain('200 gram');
    console.log(`Iron: mass ${r.mass_kg!.toFixed(4)} kg, independent ${independent.toFixed(4)} kg. ${heavy.message}`);

    // In the hard band the limit is 300 g, and it is still too heavy.
    expect(codes(validate(spec({ width_mm: 60, height_mm: 55, material: 'iron' }), { band: 'hard' }))).toContain('TOO_HEAVY');
  });

  it('(f) slippery ice at high mass SLIPS on Earth and passes the friction check on Bennu', () => {
    const icy = spec({ kind: 'bus', width_mm: 70, height_mm: 60, material: 'ice', seed: 1 });
    const earth = validate(icy, { band: 'hard', gravity_m_s2: GRAVITY.earth });
    const bennu = validate(icy, { band: 'hard', gravity_m_s2: GRAVITY.bennu });
    expect(earth.mass_kg).toBe(bennu.mass_kg);
    expect(codes(earth)).toContain('SLIPS');
    expect(earth.verdict).toBe('REFUSED');
    expect(codes(bennu)).toContain('FRICTION_OK');
    expect(codes(bennu)).not.toContain('SLIPS');
    expect(bennu.verdict).toBe('READY_FOR_LIFT_TEST');
    expect(earth.friction!.required_mu).toBeGreaterThan(earth.friction!.mu);
    expect(bennu.friction!.required_mu).toBeLessThan(bennu.friction!.mu);
    expect(earth.friction!.priority).toBe(true);
    console.log(`Ice ${(earth.mass_kg! * 1000).toFixed(0)} g: Earth needs mu ${earth.friction!.required_mu.toFixed(4)}, Bennu needs ${bennu.friction!.required_mu.toExponential(2)}, ice has 0.03.`);
    console.log(`Slips: ${stepOf(earth, 'SLIPS')!.message}`);
    // In the hand-flown band the same request is shrunk to 55 mm at the jaw, light enough to hold.
    const hand = validate(icy);
    expect(hand.mass_kg!).toBeLessThan(earth.mass_kg!);
    expect(codes(hand)).toContain('FRICTION_OK');
  });

  it('(f2) the comet ice shard SLIPS because the pads meet it off square, at any gravity; a square ice block does not', () => {
    const shard = PRESETS.find((p) => p.id === 'comet-ice-shard')!.spec;
    const earth = validate(shard, { gravity_m_s2: GRAVITY.earth });
    const bennu = validate(shard, { gravity_m_s2: GRAVITY.bennu });
    for (const r of [earth, bennu]) {
      expect(codes(r)).toContain('SLIPS');
      expect(codes(r)).not.toContain('FRICTION_OK');
      expect(r.verdict).toBe('REFUSED');
      expect(r.friction!.squeeze_angle_deg!).toBeGreaterThan(5);
      expect(r.friction!.squeeze_mu).toBeGreaterThan(r.friction!.mu);
      expect(r.friction!.required_mu).toBeCloseTo(r.friction!.squeeze_mu + r.friction!.weight_mu, 12);
    }
    // Its weight alone would be fine: about 8 g needs mu 0.0016 at Earth gravity, and ice has 0.03.
    expect(earth.friction!.weight_mu).toBeLessThan(earth.friction!.mu);
    expect(stepOf(earth, 'SLIPS')!.message).toMatch(/\(Earth\)/);
    expect(stepOf(earth, 'SLIPS')!.message).toMatch(/Lower gravity would not help\.$/);
    console.log(`Shard: ${stepOf(earth, 'SLIPS')!.message}`);
    // A box-like ice bus has square sides at its narrowest yaw, so only its weight counts.
    const block = validate(spec({ kind: 'bus', width_mm: 30, height_mm: 30, roughness: 0.2, lumpiness: 0.1, material: 'ice', seed: 3 }));
    expect(block.friction!.squeeze_angle_deg!).toBeLessThan(0.5);
    expect(codes(block)).toContain('FRICTION_OK');
    // The rock and metal presets keep passing the friction check.
    for (const p of PRESETS.filter((x) => x.spec.material !== 'ice')) expect(codes(validate(p.spec)), p.id).toContain('FRICTION_OK');
  });

  it('(g) NaN, flat and under-4-vertex meshes give BAD_MESH with no crash', () => {
    const nan = Float32Array.from([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0, 0, 0, Number.NaN]);
    const flat = Float32Array.from([0, 0, 0, 0.03, 0, 0, 0, 0.03, 0, 0.03, 0.03, 0]);
    const tiny = Float32Array.from([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0]);
    for (const [name, positions] of [['NaN', nan], ['flat', flat], ['three vertices', tiny], ['empty', new Float32Array(0)]] as const) {
      const r = validateMesh({ positions, indices: Uint32Array.from([0, 1, 2]) }, spec());
      expect(r.verdict, name).toBe('REFUSED');
      expect(codes(r)[0], name).toBe('BAD_MESH');
      expect(r.mesh).toBeNull();
      console.log(`${name}: ${r.steps[0]!.message}`);
    }
    // Garbage in place of a mesh does not throw either.
    expect(validateMesh({} as never, null).verdict).toBe('REFUSED');
    expect(validateMesh({ positions: 'nope' } as never, spec()).verdict).toBe('REFUSED');
  });

  it('bad spec values are clamped, not trusted', () => {
    const r = validate({ kind: 'blackhole', width_mm: Number.NaN, height_mm: -5, roughness: 7, seed: 'x', material: 'unobtainium', color: 'red' });
    expect(r.spec.kind).toBe('asteroid');
    expect(r.spec.width_mm).toBe(40);
    expect(r.spec.height_mm).toBe(1);
    expect(r.spec.roughness).toBe(1);
    expect(r.spec.material).toBe('c_type_rock');
    expect(r.steps.filter((s) => s.code === 'SPEC_CLAMPED').length).toBeGreaterThanOrEqual(6);
    expect(validate(spec(), { gravity_m_s2: Number.NaN }).gravity_m_s2).toBe(GRAVITY.earth);
    expect(validate(spec({ material: 'c_type_rock' }), { density_g_cc: 9 }).density_g_cc).toBe(2.3);
  });

  it('(j) with no lift tester a receipt reads READY_FOR_LIFT_TEST, never PASS, and says so', () => {
    const samples = [...PRESETS.map((p) => p.spec), spec({ width_mm: 1e6, height_mm: 9e5 }), spec({ width_mm: 5, height_mm: 4 })];
    for (const s of samples) {
      const r = validate(s);
      expect(r.verdict).not.toBe('PASS');
      expect(r.verdict).not.toBe('ADJUSTED');
      expect(['READY_FOR_LIFT_TEST', 'REFUSED']).toContain(r.verdict);
      expect(r.lift.status).toBe('not_run');
      expect(r.lift.message).toContain(LIFT_NOT_RUN_TEXT);
      expect(r.steps[r.steps.length - 1]!.message).toContain(LIFT_NOT_RUN_TEXT);
    }
    // Every preset reaches the lift test except the comet ice shard, which is there to SLIP (test f2).
    for (const p of PRESETS) expect(validate(p.spec).verdict, p.id).toBe(p.id === 'comet-ice-shard' ? 'REFUSED' : 'READY_FOR_LIFT_TEST');
  });

  it('a lift tester decides PASS, ADJUSTED or LIFT_FAILED, retrying the next-best yaws', async () => {
    const calls: LiftRequest[] = [];
    const holds: LiftTester = { name: 'fake-holds (test double, not the arm)', testLift: async (req) => (calls.push(req), { simulated: true, rise_mm: 70 }) };
    const drops: LiftTester = { name: 'fake-drops (test double, not the arm)', testLift: async (req) => (calls.push(req), { simulated: true, rise_mm: 12 }) };
    const breaks: LiftTester = { name: 'fake-throws', testLift: async () => Promise.reject(new Error('worker crashed')) };

    const plain = validate(spec());
    expect((await proveLift(plain, holds)).verdict).toBe('PASS');
    const scaled = validate(spec({ width_mm: 3000, height_mm: 2500 }));
    const adjusted = await proveLift(scaled, holds);
    expect(adjusted.verdict).toBe('ADJUSTED');
    expect(adjusted.steps.at(-1)!.message).toContain('simulated lift test');

    calls.length = 0;
    const failed = await proveLift(plain, drops);
    expect(failed.verdict).toBe('REFUSED');
    expect(failed.steps.at(-1)!.code).toBe('LIFT_FAILED');
    expect(calls.map((c) => c.yaw_deg)).toEqual(plain.yaw_candidates_deg.slice(0, 3));
    expect(failed.steps.at(-1)!.message).toContain('I tried in simulation and dropped it');

    const errored = await proveLift(plain, breaks);
    expect(errored.verdict).toBe('READY_FOR_LIFT_TEST');
    expect(errored.lift.status).toBe('error');

    const refused = validate(spec({ material: 'iron', width_mm: 60, height_mm: 55 }));
    expect((await proveLift(refused, holds)).verdict).toBe('REFUSED');
  });

  it('messages are honest sentences: never just "invalid", and any lift line credits the simulated lift test', () => {
    const receipts = [
      validate(spec()),
      validate(spec({ width_mm: 1e6, height_mm: 8e5 })),
      validate(spec({ kind: 'fragment', width_mm: 2, height_mm: 2000 })),
      validate(spec({ material: 'iron', width_mm: 60, height_mm: 55 })),
      validate(spec({ kind: 'bus', width_mm: 70, height_mm: 60, material: 'ice' })),
      validate(spec({ width_mm: 4, height_mm: 3 })),
      validateMesh({ positions: new Float32Array(3) }, spec()),
      ...PRESETS.map((p) => validate(p.spec)),
    ];
    for (const r of receipts) {
      for (const s of r.steps) {
        expect(s.message).not.toMatch(/\binvalid\b/i);
        expect(s.message).toMatch(/[.?!]$/);
        if (/\blift/i.test(s.message)) expect(s.message, s.code).toMatch(/simulated lift test|in simulation/);
      }
    }
  });

  it('hard and hand-flown bands are the researched numbers', () => {
    expect(HARD_BAND).toMatchObject({ w_min: 0.01, w_max: 0.07, h_max: 0.06, m_max: 0.3 });
    expect(HAND_BAND).toMatchObject({ w_min: 0.015, w_max: 0.055, m_max: 0.2 });
  });
});
