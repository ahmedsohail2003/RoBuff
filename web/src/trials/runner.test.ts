import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ArmController } from '../control/armController';
import { ControlLoop } from '../control/controlLoop';
import { ArmIk } from '../control/ik';
import { cubePickPlan } from '../input/scene';
import { SyntheticSource } from '../input/syntheticSource';
import { DelayRig } from '../delay/dualSim';
import { GRIPPER_SITE, meshFilesIn } from '../sim/armXml';
import { ARM_XML, SCENE_XML, compileModel, type ModelFiles } from '../sim/compileModel';
import { gravity, registerGravityTarget } from '../sim/gravity';
import { loadNode } from '../sim/loadModelNode';
import { physicsOnlyFiles } from '../sim/physicsScene';
import { Simulation } from '../sim/simulation';
import { CSV_COLUMNS, toCsv } from './logger';
import { TrialRunner } from './runner';

const MODEL_DIR = path.resolve(import.meta.dirname, '../../public/models/so_arm100');
let rig: DelayRig;

beforeAll(async () => {
  const { mujoco, model } = await loadNode();
  const read = (file: string) => readFileSync(path.join(MODEL_DIR, file));
  const armXml = read(ARM_XML).toString('utf8');
  const meshPaths = meshFilesIn(armXml).map((file) => `assets/${file}`);
  const files: ModelFiles = { armXml, sceneXml: read(SCENE_XML).toString('utf8'), meshes: new Map(meshPaths.map((p) => [p, new Uint8Array(read(p))])) };
  const sim = new Simulation(mujoco, model);
  const loop = new ControlLoop(sim, new ArmController(sim, new ArmIk(mujoco, model, GRIPPER_SITE)));
  registerGravityTarget('live', () => loop.sim.model);
  loop.source = new SyntheticSource(() => cubePickPlan(sim));
  rig = new DelayRig(mujoco, loop, () => compileModel(mujoco, physicsOnlyFiles(files)));
}, 60_000);

/** Steps the rig until the trial's promise settles (the runner only measures; it does not step). */
async function stepUntil(promise: Promise<unknown>, maxSimS: number): Promise<void> {
  let settled = false;
  void promise.then(() => (settled = true));
  const start = rig.loop.sim.time;
  while (!settled && rig.loop.sim.time - start < maxSimS) {
    rig.advance(50);
    await Promise.resolve();
  }
}

describe('trial runner (synthetic hand: checks the logger, never gate data)', () => {
  it('logs one row per trial with the 33 columns; the synthetic pick is a stable lift in Direct and in Moon-ghost-on', async () => {
    const runner = new TrialRunner(rig, { operator: 'synthetic-hand', buildId: 'unit', fps: () => 60, persist: false });
    // Trial 1 is a direct warm-up.
    const first = runner.runNext(0);
    await stepUntil(first, 95);
    const direct = await first;
    expect(direct.condition).toBe('direct');
    expect(direct.practice).toBe('1');
    expect(direct.success).toBe('1');
    expect(gravity.current.id).toBe('moon');
    // Jump to the first ghost_on trial (the order is fixed; skip by logging nothing: run until it comes up).
    const rows = [direct];
    while (runner.current?.condition !== 'ghost_on') {
      const p = runner.runNext(0);
      await stepUntil(p, 95);
      rows.push(await p);
    }
    const p = runner.runNext(0);
    await stepUntil(p, 95);
    const on = await p;
    rows.push(on);
    console.log(`TRIAL_ROWS\n${toCsv(rows)}`);
    expect(on.condition).toBe('ghost_on');
    expect(on.delay_oneway_ms).toBe('1280');
    expect(on.success).toBe('1');
    expect(Number(on.completion_s)).toBeGreaterThan(Number(direct.completion_s));
    expect(on.max_ghost_err_mm).not.toBe('');
    expect(Object.keys(on)).toEqual([...CSV_COLUMNS]);
    expect(toCsv(rows).trim().split('\n')).toHaveLength(rows.length + 1);
  }, 120_000);
});
