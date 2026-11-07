import { beforeAll, describe, expect, it } from 'vitest';
import { ArmController } from '../control/armController';
import { ControlLoop } from '../control/controlLoop';
import { ArmIk } from '../control/ik';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { proveLift } from '../objects/lift';
import { validate } from '../objects/guardrail';
import { PRESETS, specFromText } from '../objects/mock';
import { withSettleStep } from '../objects/settle';
import type { Receipt } from '../objects/receipt';
import { GRIPPER_SITE, meshFilesIn } from './armXml';
import { ARM_XML, SCENE_XML, compileModel, type ModelFiles } from './compileModel';
import { ArmLiftTester, liftPhases, sampleLift, scoreLift, type LiftSample } from './liftTester';
import { loadNode } from './loadModelNode';
import type { Mujoco } from './mujocoRuntime';
import { ObjectSlot, sceneWithObject } from './objectSlot';
import { physicsOnlyFiles } from './physicsScene';
import { Simulation } from './simulation';

const PASS = 0.048;

function samples(rises: number[], closedFrom = 0, dt = 0.01): LiftSample[] {
  return rises.map((rise, i) => ({ t: (i + 1) * dt, phase: 'hold', rise, closed: i >= closedFrom }));
}

describe('lift test result logic', () => {
  it('counts the rise at the end of the hold, not the best moment', () => {
    const dropped = scoreLift(samples([0, 0.02, 0.06, 0.08, 0.08, 0.01]), PASS);
    expect(dropped.rise).toBeCloseTo(0.01);
    expect(dropped.maxRise).toBeCloseTo(0.08);
    const held = scoreLift(samples([0, 0.03, 0.06, 0.079, 0.079]), PASS);
    expect(held.rise).toBeCloseTo(0.079);
  });

  it('hold time is the longest closed stretch at or above the pass rise', () => {
    const rises = [0, 0.05, 0.05, 0.05, 0.03, 0.05, 0.05];
    const score = scoreLift(samples(rises), PASS);
    expect(score.holdS).toBeCloseTo(0.02);
    // An open grip never counts as holding, however high the object is.
    expect(scoreLift(samples([0.06, 0.06, 0.06], 99), PASS).holdS).toBe(0);
  });

  it('no samples or NaN gives zero, never a pass', () => {
    expect(scoreLift([], PASS)).toEqual({ rise: 0, maxRise: 0, holdS: 0 });
    expect(scoreLift(samples([0.06, Number.NaN]), PASS).rise).toBe(0);
  });

  it('phases open to the given grip, descend, close, lift by the lift height and hold 1 s', () => {
    const phases = liftPhases([0, -0.22, 0.02], 0.4, 0.08);
    expect(phases.map((p) => p.name)).toEqual(['above', 'down', 'close', 'lift', 'hold']);
    expect(phases[1]!.grip).toBe(0.4);
    expect(phases[3]!.waypoint[2]).toBeCloseTo(0.1);
    expect(phases[4]!.dwellS).toBe(1);
    const total = phases.reduce((s, p) => s + p.moveS + p.dwellS, 0);
    expect(sampleLift(phases, [0, -0.24, 0.08], 0.9, total - 0.001)!.phase).toBe('hold');
    expect(sampleLift(phases, [0, -0.24, 0.08], 0.9, total + 0.001)).toBeNull();
    expect(sampleLift(phases, [0, -0.24, 0.08], 0.9, 0)!.grip).toBeCloseTo(0.9);
  });
});

const MODEL_DIR = path.resolve(import.meta.dirname, '../../public/models/so_arm100');
let mujoco: Mujoco;
let files: ModelFiles;

let loadNodeModel: Awaited<ReturnType<typeof loadNode>>['model'];

beforeAll(async () => {
  const loaded = await loadNode();
  mujoco = loaded.mujoco;
  loadNodeModel = loaded.model;
  const read = (file: string) => readFileSync(path.join(MODEL_DIR, file));
  const armXml = read(ARM_XML).toString('utf8');
  const meshPaths = meshFilesIn(armXml).map((file) => `assets/${file}`);
  files = physicsOnlyFiles({ armXml, sceneXml: read(SCENE_XML).toString('utf8'), meshes: new Map(meshPaths.map((p) => [p, new Uint8Array(read(p))])) });
}, 60_000);

async function spawnAndProve(text: string): Promise<{ receipt: Receipt; slot: ObjectSlot; tester: ArmLiftTester; spawnMs: number }> {
  const model = compileModel(mujoco, files);
  const sim = new Simulation(mujoco, model);
  const loop = new ControlLoop(sim, new ArmController(sim, new ArmIk(mujoco, model, GRIPPER_SITE)));
  const slot = new ObjectSlot(mujoco, files, loop);
  const gravity = Math.abs((model.opt.gravity as Float64Array)[2]!);
  let receipt = validate(specFromText(text).spec, { gravity_m_s2: gravity });
  expect(receipt.verdict, text).toBe('READY_FOR_LIFT_TEST');
  const spawn = slot.spawn(receipt);
  receipt = withSettleStep(receipt, spawn.settleStep, spawn.rest);
  const tester = new ArmLiftTester(mujoco, { live: () => slot.sim, bodyName: slot.bodyName });
  receipt = await proveLift(receipt, tester);
  return { receipt, slot, tester, spawnMs: spawn.swap_ms };
}

describe('object slot and lift test in MuJoCo', () => {
  it('the physics-only arm keeps every body and collision geom, inlines hull points and drops visual geoms', () => {
    expect(files.armXml).not.toMatch(/file="/);
    expect(files.armXml).not.toMatch(/<geom[^>]*class="(visual|motor_visual)"/);
    const full = loadNodeModel;
    const lean = compileModel(mujoco, files);
    const names = (m: typeof lean) => Array.from({ length: m.nbody }, (_, i) => mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_BODY.value, i));
    expect(names(lean)).toEqual(names(full));
    expect(lean.nbody).toBe(full.nbody);
    // Moving bodies: identical mass and inertia (explicit <inertial>). Base (id 1) is welded to
    // the world, so its mass, computed from the mesh volume, never enters the dynamics.
    expect(Array.from(lean.body_mass as Float64Array).slice(2)).toEqual(Array.from(full.body_mass as Float64Array).slice(2));
    expect(Array.from(lean.body_inertia as Float64Array).slice(6)).toEqual(Array.from(full.body_inertia as Float64Array).slice(6));
    expect((lean.body_jntnum as Int32Array)[1]).toBe(0);
    lean.delete();
  });

  it('the scene XML loses the cube and gains the object as the last body', () => {
    const r = validate(PRESETS[0]!.spec);
    const xml = sceneWithObject(files.sceneXml, { asset: '<mesh name="m" vertex="0 0 0 1 0 0 0 1 0 0 0 1"/>', body: '<body name="b"/>' } as never);
    expect(xml).not.toContain('name="cube"');
    expect(xml.indexOf('<body name="b"/>')).toBeGreaterThan(xml.indexOf('name="floor"'));
    expect(r.verdict).toBe('READY_FOR_LIFT_TEST');
  });

  it('Bennu-like sample: spawned, settled on the pad, and lifted by the headless arm test', async () => {
    const { receipt, slot, tester, spawnMs } = await spawnAndProve('bennu-sample');
    console.log(`S5_NODE_BENNU spawn ${spawnMs.toFixed(1)} ms ${JSON.stringify(tester.runs)} verdict ${receipt.verdict}`);
    const pos = slot.sim.getBodyPos(slot.bodyName)!;
    expect(Math.hypot(pos[0], pos[1] + 0.22)).toBeLessThan(0.03);
    expect(receipt.verdict).toBe('PASS');
    expect(receipt.lift.attempts.at(-1)!.rise_mm).toBeGreaterThanOrEqual(48);
    expect(slot.sim.getCtrl().every(Number.isFinite)).toBe(true);
  }, 60_000);

  it('the friction check agrees with the lift test on ice: the shard it calls SLIPS drops, the square block it passes lifts', async () => {
    const gravityOf = (m: { opt: { gravity: unknown } }) => Math.abs((m.opt.gravity as Float64Array)[2]!);
    const block = { kind: 'bus', width_mm: 30, height_mm: 30, roughness: 0.2, lumpiness: 0.1, seed: 3, material: 'ice', color: '#cfe6f2', why: 'square ice block' };
    const cases = [
      { name: 'comet ice shard', spec: PRESETS.find((p) => p.id === 'comet-ice-shard')!.spec, check: 'SLIPS' },
      { name: '30 mm ice block', spec: block, check: 'FRICTION_OK' },
    ];
    const results: string[] = [];
    for (const c of cases) {
      const model = compileModel(mujoco, files);
      const sim = new Simulation(mujoco, model);
      const loop = new ControlLoop(sim, new ArmController(sim, new ArmIk(mujoco, model, GRIPPER_SITE)));
      const slot = new ObjectSlot(mujoco, files, loop);
      const checked = validate(c.spec, { gravity_m_s2: gravityOf(model) });
      expect(checked.steps.map((s) => s.code), c.name).toContain(c.check);
      // Cross-check only: run the lift test even on the refused shard, to see whether SLIPS was right.
      // The app never does this; a refused receipt is not spawned.
      let receipt: Receipt = { ...checked, verdict: 'READY_FOR_LIFT_TEST' };
      const spawn = slot.spawn(receipt);
      receipt = withSettleStep(receipt, spawn.settleStep, spawn.rest);
      const tester = new ArmLiftTester(mujoco, { live: () => slot.sim, bodyName: slot.bodyName });
      await proveLift(receipt, tester);
      const best = Math.max(...tester.runs.map((r) => r.rise_mm));
      results.push(`${c.name}: ${c.check}, needs mu ${checked.friction!.required_mu.toFixed(4)}, has ${checked.friction!.mu}; lift test ${tester.runs.map((r) => `${r.rise_mm.toFixed(1)} mm`).join(', ')}`);
      if (c.check === 'SLIPS') {
        expect(tester.runs).toHaveLength(3);
        expect(best, c.name).toBeLessThan(48);
      } else {
        expect(tester.runs.at(-1)!.rise_mm, c.name).toBeGreaterThanOrEqual(48);
      }
    }
    console.log(`S5_NODE_ICE_CROSSCHECK ${results.join(' | ')}`);
  }, 120_000);

  it('an asteroid the size of Texas is rescaled and lifted', async () => {
    const { receipt, tester } = await spawnAndProve('an asteroid the size of Texas');
    console.log(`S5_NODE_TEXAS ${JSON.stringify(tester.runs)} verdict ${receipt.verdict}`);
    expect(receipt.steps.some((s) => s.code === 'TOO_WIDE')).toBe(true);
    expect(receipt.verdict).toBe('ADJUSTED');
  }, 60_000);
});
