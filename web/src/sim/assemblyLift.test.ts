// (c) Objects from parts in the live arena: guardrail, spawn and settle on the pad, then the
// headless lift test on the real multi-geom body, to a verdict.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ArmController } from '../control/armController';
import { ControlLoop } from '../control/controlLoop';
import { ArmIk } from '../control/ik';
import { validate } from '../objects/guardrail';
import { proveLift } from '../objects/lift';
import { specFromText } from '../objects/mock';
import type { Receipt } from '../objects/receipt';
import { withSettleStep } from '../objects/settle';
import { AK47 } from '../objects/test/assemblyFixtures';
import { GRIPPER_SITE, meshFilesIn } from './armXml';
import { ARM_XML, SCENE_XML, compileModel, type ModelFiles } from './compileModel';
import { ArmLiftTester } from './liftTester';
import { loadNode } from './loadModelNode';
import type { Mujoco } from './mujocoRuntime';
import { ObjectSlot } from './objectSlot';
import { physicsOnlyFiles } from './physicsScene';
import { Simulation } from './simulation';

const MODEL_DIR = path.resolve(import.meta.dirname, '../../public/models/so_arm100');
let mujoco: Mujoco;
let files: ModelFiles;

beforeAll(async () => {
  mujoco = (await loadNode()).mujoco;
  const read = (file: string) => readFileSync(path.join(MODEL_DIR, file));
  const armXml = read(ARM_XML).toString('utf8');
  const meshPaths = meshFilesIn(armXml).map((file) => `assets/${file}`);
  files = physicsOnlyFiles({ armXml, sceneXml: read(SCENE_XML).toString('utf8'), meshes: new Map(meshPaths.map((p) => [p, new Uint8Array(read(p))])) });
}, 60_000);

async function run(spec: unknown): Promise<{ receipt: Receipt; tester: ArmLiftTester; slot: ObjectSlot; geoms: number }> {
  const model = compileModel(mujoco, files);
  const sim = new Simulation(mujoco, model);
  const loop = new ControlLoop(sim, new ArmController(sim, new ArmIk(mujoco, model, GRIPPER_SITE)));
  const slot = new ObjectSlot(mujoco, files, loop);
  let receipt = validate(spec, { gravity_m_s2: Math.abs((model.opt.gravity as Float64Array)[2]!) });
  expect(receipt.verdict).toBe('READY_FOR_LIFT_TEST');
  const spawn = slot.spawn(receipt);
  const body = mujoco.mj_name2id(slot.sim.model, mujoco.mjtObj.mjOBJ_BODY.value, slot.bodyName);
  const geoms = Array.from(slot.sim.model.geom_bodyid as Int32Array).filter((b) => b === body).length;
  receipt = withSettleStep(receipt, spawn.settleStep, spawn.rest);
  const tester = new ArmLiftTester(mujoco, { live: () => slot.sim, bodyName: slot.bodyName });
  receipt = await proveLift(receipt, tester);
  return { receipt, tester, slot, geoms };
}

describe('assemblies in the arena', () => {
  it('(c) a 5-part AK-47: guardrail, settle on the pad, headless lift test on the 5-geom body, verdict', async () => {
    const { receipt, tester, slot, geoms } = await run(AK47);
    console.log(`S5_PARTS_AK47 geoms ${geoms} size ${receipt.size_mm!.map((v) => v.toFixed(1)).join(' x ')} mm mass ${(receipt.mass_kg! * 1000).toFixed(2)} g verdict ${receipt.verdict} runs ${JSON.stringify(tester.runs.map((r) => ({ yaw: r.yaw_deg, rise_mm: +r.rise_mm.toFixed(1), hold_s: +r.hold_s.toFixed(2), jaws: r.jaws_touching })))}`);
    expect(geoms).toBe(5);
    expect(['PASS', 'ADJUSTED', 'REFUSED']).toContain(receipt.verdict);
    expect(receipt.lift.status === 'passed' || receipt.lift.status === 'failed').toBe(true);
    // Measured on this build: it passes, gripped by both jaws.
    expect(receipt.lift.status).toBe('passed');
    expect(receipt.lift.attempts.at(-1)!.rise_mm).toBeGreaterThanOrEqual(48);
    expect(tester.runs.at(-1)!.jaws_touching).toEqual(['Fixed_Jaw', 'Moving_Jaw']);
    expect(slot.sim.getCtrl().every(Number.isFinite)).toBe(true);
  }, 120_000);

  it('the offline car, plane and mug assemblies each reach a verdict; a failed lift is a refusal', async () => {
    const rows: string[] = [];
    for (const text of ['a tesla', 'a plane', 'a coffee mug']) {
      const { receipt, tester, geoms } = await run(specFromText(text).spec);
      rows.push(`${text}: ${geoms} geoms, ${receipt.size_mm!.map((v) => v.toFixed(1)).join(' x ')} mm, ${(receipt.mass_kg! * 1000).toFixed(1)} g, ${receipt.verdict}, rises ${tester.runs.map((r) => r.rise_mm.toFixed(1)).join(', ')} mm`);
      expect(geoms).toBe(receipt.parts!.length);
      if (receipt.lift.status === 'failed') {
        expect(receipt.verdict).toBe('REFUSED');
        expect(receipt.steps.at(-1)!.code).toBe('LIFT_FAILED');
      } else {
        expect(receipt.lift.status).toBe('passed');
      }
    }
    console.log(`S5_PARTS_OFFLINE\n${rows.join('\n')}`);
  }, 180_000);
});
