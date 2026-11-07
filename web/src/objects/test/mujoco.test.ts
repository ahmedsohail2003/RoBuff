import loadMujoco, { type MainModule } from '@mujoco/mujoco';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkObject } from '../check';
import { GALLERY_SPECS } from '../gallery';
import { validate } from '../guardrail';
import { GRAVITY } from '../limits';
import { MjcfExportError, MjcfNamer, toMjcf } from '../mjcf';
import { settle, settleSceneXml } from '../settle';
import { spec } from './helpers';

let mj: MainModule;

beforeAll(async () => {
  mj = await loadMujoco();
});

describe('MJCF in real MuJoCo WASM (Node)', () => {
  it('(h, i) 12 varied objects compile, step 500 times with finite state, settle on the plane, and keep the receipt mass', () => {
    const rows: string[] = [];
    const results: { label: string; mass: number; report: ReturnType<typeof settle> }[] = [];
    for (const { label, spec: s, options } of GALLERY_SPECS) {
      // Refused objects that still have a safe hull (the slipping ice block) are dropped too.
      const receipt = validate(s, options);
      expect(receipt.hull, label).not.toBeNull();
      const report = settle(mj, receipt, { fixed_steps: 500, gravity_m_s2: GRAVITY.earth });
      results.push({ label, mass: receipt.mass_kg!, report });
      rows.push(
        `${label.padEnd(40)} compile ${report.compile_ms.toFixed(1).padStart(6)} ms  rolled ${report.rolled_mm.toFixed(2).padStart(6)} mm  turned ${report.rotated_deg.toFixed(1).padStart(5)} deg  ` +
          `speed ${report.final_speed_mm_s.toFixed(3)} mm/s  turn ${report.final_turn_deg_s.toFixed(2)} deg/s  jitter ${report.jitter_deg_s.toFixed(1)} deg/s  lowest ${report.rest_lowest_mm.toFixed(3)} mm  ` +
          `mass ${(receipt.mass_kg! * 1000).toFixed(3)} g  model ${(report.model_mass_kg * 1000).toFixed(3)} g  ${report.step.code}`,
      );
    }
    const compileMs = results.map((r) => r.report.compile_ms).sort((a, b) => a - b);
    const median = (compileMs[5]! + compileMs[6]!) / 2;
    const largestRoll = Math.max(...results.map((r) => r.report.rolled_mm));
    const tested = results.length;
    console.log(`${rows.join('\n')}\nobjects ${tested}, median compile ${median.toFixed(1)} ms, largest rolled ${largestRoll.toFixed(2)} mm`);

    for (const { label, mass, report } of results) {
      expect(report.steps).toBe(500);
      expect(report.finite, label).toBe(true);
      expect(report.touched, label).toBe(true);
      // On the plane: lowest hull point within 2 mm of the floor (soft contact allows slight penetration).
      expect(report.rest_lowest_mm, label).toBeGreaterThan(-2);
      expect(report.rest_lowest_mm, label).toBeLessThan(1);
      // Near rest after 1 s: over the last 50 ms the pose moved slower than 2 mm/s and 3 deg/s.
      expect(report.final_speed_mm_s, label).toBeLessThan(2);
      expect(report.final_turn_deg_s, label).toBeLessThan(3);
      // (i) Compiled mass equals the receipt mass within 0.1 percent.
      expect(Math.abs(report.model_mass_kg / mass - 1), label).toBeLessThan(0.001);
    }
    expect(tested).toBeGreaterThanOrEqual(12);
  });

  it('fragments carry maxhullvert 64, explicit mass, safe unique names, and priority only when slippery', () => {
    const namer = new MjcfNamer();
    const rock = validate(spec());
    const ice = validate(spec({ kind: 'fragment', material: 'ice', width_mm: 30, height_mm: 25 }));
    const a = toMjcf(rock, { namer, name: 'rock <evil> "name"' });
    const b = toMjcf(rock, { namer, name: 'rock <evil> "name"', pos: [0.1, 0, 0.002] });
    const c = toMjcf(ice, { namer, pos: [-0.1, 0, 0.002] });
    expect(a.names.body).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(a.names.body).not.toBe(b.names.body);
    expect(a.asset).toContain('maxhullvert="64"');
    expect(a.body).toMatch(/mass="0\.0\d+/);
    expect(a.body).not.toContain('priority');
    expect(c.body).toContain('priority="1"');
    expect(c.body).toContain('friction="0.03 ');

    // All three in one model: names never collide.
    const model = mj.MjModel.from_xml_string(settleSceneXml([a, b, c], GRAVITY.earth));
    expect(model.nbody).toBe(4);
    const data = new mj.MjData(model);
    for (let i = 0; i < 200; i++) mj.mj_step(model, data);
    expect(Array.from(data.qpos as Float64Array).every(Number.isFinite)).toBe(true);
    const priorities = Array.from(model.geom_priority as Int32Array);
    expect(priorities).toEqual([0, 0, 0, 1]);
    data.delete();
    model.delete();

    expect(() => toMjcf(validate(spec({ kind: 'fragment', width_mm: 2, height_mm: 2000 })))).toThrow(MjcfExportError);
  });

  it('settle stops when still, notes rolls over 10 mm, and is honest at Bennu gravity', () => {
    const earth = settle(mj, validate(spec({ seed: 101955, width_mm: 40, height_mm: 33, roughness: 0.6, lumpiness: 0.65 })));
    expect(earth.settled).toBe(true);
    expect(earth.sim_seconds).toBeLessThanOrEqual(1.5);
    expect(earth.step.code).toBe(earth.rolled_mm > 10 ? 'ROLLS' : 'SETTLED');
    console.log(`Earth settle: ${earth.sim_seconds.toFixed(3)} s, ${earth.step.message}`);

    const bennu = settle(mj, validate(spec(), { gravity_m_s2: GRAVITY.bennu }));
    expect(bennu.settled).toBe(false);
    expect(bennu.step.code).toBe('SETTLE_TIMEOUT');
    console.log(`Bennu settle: ${bennu.step.message}`);
  });

  it('checkObject runs validate, settle and stops at READY_FOR_LIFT_TEST without a tester', async () => {
    const { receipt, settle: report } = await checkObject(mj, spec());
    expect(receipt.verdict).toBe('READY_FOR_LIFT_TEST');
    expect(report).not.toBeNull();
    expect(receipt.steps.map((s) => s.code).slice(-2)[0]).toMatch(/SETTLED|ROLLS/);
    const passed = await checkObject(mj, spec(), { liftTester: { name: 'fake (test double)', testLift: async () => ({ simulated: true, rise_mm: 60 }) } });
    expect(passed.receipt.verdict).toBe('PASS');
  });
});
