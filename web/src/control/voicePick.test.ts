// (g) Real physics in Node: the voice source runs planPick on the arena test cube and on a
// 5-part assembly (the AK-47 fixture, after its own lift test), and the pick check passes
// (rise >= 48 mm, both jaws). Then planPlace puts it down and it settles on the floor.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ArmController } from './armController';
import { ControlLoop } from './controlLoop';
import { ArmIk } from './ik';
import { checkPick, planPick, PICK_MIN_WIDTH, runPick, runPlace, type MacroResult, type MacroWorld } from './armMacro';
import { validate } from '../objects/guardrail';
import { proveLift } from '../objects/lift';
import { withSettleStep } from '../objects/settle';
import { AK47 } from '../objects/test/assemblyFixtures';
import { VoiceSource } from '../input/voiceSource';
import { StopLatch } from '../safety/latch';
import { GRIPPER_SITE, meshFilesIn } from '../sim/armXml';
import { ARM_XML, SCENE_XML, compileModel, type ModelFiles } from '../sim/compileModel';
import { ArmLiftTester } from '../sim/liftTester';
import { jawAngleForGapScratch, jawContacts, liveObject, slotBodyName } from '../sim/liveObject';
import { loadNode } from '../sim/loadModelNode';
import type { Mujoco } from '../sim/mujocoRuntime';
import { ObjectSlot } from '../sim/objectSlot';
import { physicsOnlyFiles } from '../sim/physicsScene';
import { Simulation } from '../sim/simulation';

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

function makeLoop(): ControlLoop {
  const model = compileModel(mujoco, files);
  const sim = new Simulation(mujoco, model);
  const loop = new ControlLoop(sim, new ArmController(sim, new ArmIk(mujoco, model, GRIPPER_SITE)));
  loop.stopLatch = new StopLatch();
  return loop;
}

function worldFor(loop: ControlLoop, voice: VoiceSource, body: string): MacroWorld {
  return {
    run: (steps, label) => voice.runSteps(steps, label),
    read: () => liveObject(mujoco, loop.sim, body),
    jaws: () => jawContacts(loop.sim, body),
    grip: () => loop.controller.status().grip ?? 0,
    site: () => voice.endGoal(),
  };
}

/** Steps physics until the macro settles (its steps resolve inside poll; the awaits run between slices). */
async function drive(loop: ControlLoop, pending: Promise<MacroResult>, maxS: number): Promise<MacroResult> {
  let result: MacroResult | null = null;
  void pending.then((r) => (result = r));
  const end = loop.sim.time + maxS;
  while (result === null && loop.sim.time < end) {
    loop.advance(10);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (result === null) throw new Error(`macro did not finish in ${maxS} s`);
  return result;
}

async function pickAndPlace(loop: ControlLoop, body: string, tag: string): Promise<void> {
  const voice = new VoiceSource(loop, { parked: null });
  loop.source = voice;
  loop.advance(250);
  const sim = loop.sim;
  const obj = liveObject(mujoco, sim, body);
  const [closed, open] = sim.jawRange();
  const plan = planPick(obj, { range: [closed, open], angleForGap: (gap) => jawAngleForGapScratch(mujoco, sim, gap) }, voice.endGoal());
  if (!plan.ok) throw new Error(plan.refuse);
  expect(plan.width).toBeGreaterThanOrEqual(PICK_MIN_WIDTH);
  const world = worldFor(loop, voice, body);
  const picked = await drive(loop, runPick(world, plan), 20);
  const check = picked.check ?? checkPick(0, [], 0);
  console.log(`${tag}_PICK ${picked.line} width ${(plan.width * 1000).toFixed(1)} mm open grip ${plan.openGrip.toFixed(3)} rise ${check.riseMm.toFixed(1)} mm jaws ${check.jaws.join('+')}`);
  expect(picked.ok).toBe(true);
  expect(check.riseMm).toBeGreaterThanOrEqual(48);
  expect(check.jaws).toEqual(['Fixed_Jaw', 'Moving_Jaw']);
  // Held for another second: no drop.
  loop.advance(500);
  expect(jawContacts(loop.sim, body)).toEqual(['Fixed_Jaw', 'Moving_Jaw']);
  const placed = await drive(loop, runPlace(world, picked.ok ? picked.holding! : { body, openGrip: plan.openGrip, restZ: plan.restZ }), 20);
  loop.advance(250);
  const after = liveObject(mujoco, loop.sim, body);
  const before = liveObject(mujoco, loop.sim, body);
  loop.advance(25);
  const later = liveObject(mujoco, loop.sim, body);
  const speed = Math.hypot(later.com[0] - before.com[0], later.com[1] - before.com[1], later.com[2] - before.com[2]) / (25 * loop.sim.timestep);
  console.log(`${tag}_PLACE ${placed.line} lowest ${(after.lowest * 1000).toFixed(1)} mm, com ${(after.com[2] * 1000).toFixed(1)} mm (rest ${(plan.restZ * 1000).toFixed(1)}), speed ${(speed * 1000).toFixed(2)} mm/s, jaws ${jawContacts(loop.sim, body).join('+') || 'none'}`);
  expect(placed.ok).toBe(true);
  expect(jawContacts(loop.sim, body)).toEqual([]);
  expect(after.lowest).toBeLessThan(0.005);
  expect(speed).toBeLessThan(0.002);
}

describe('(g) voice pick and place on the real physics', () => {
  it('picks the arena test cube with both jaws, lifts it 48 mm or more, and puts it down', async () => {
    const loop = makeLoop();
    expect(slotBodyName(mujoco, loop.sim)).toBe('cube');
    const cube = liveObject(mujoco, loop.sim, 'cube');
    // Box corners now count as points: 8 corners, 30 mm across.
    expect(cube.points.length).toBe(24);
    expect(cube.height).toBeCloseTo(0.03, 4);
    await pickAndPlace(loop, 'cube', 'VOICE_CUBE');
  }, 120_000);

  it('picks a 5-part AK-47 assembly after its lift test, and puts it down', async () => {
    const loop = makeLoop();
    const slot = new ObjectSlot(mujoco, files, loop);
    let receipt = validate(AK47, { gravity_m_s2: Math.abs((loop.sim.model.opt.gravity as Float64Array)[2]!) });
    const spawn = slot.spawn(receipt);
    receipt = withSettleStep(receipt, spawn.settleStep, spawn.rest);
    const tester = new ArmLiftTester(mujoco, { live: () => slot.sim, bodyName: slot.bodyName });
    receipt = await proveLift(receipt, tester);
    expect(receipt.lift.status).toBe('passed');
    // As the object panel does after a pass: turn the live object the way the passing attempt did.
    const run = tester.runs[tester.runs.length - 1]!;
    if (Math.abs(run.turn_deg) >= 0.5) slot.turnObject((run.turn_deg * Math.PI) / 180);
    expect(slotBodyName(mujoco, loop.sim)).toBe(slot.bodyName);
    await pickAndPlace(loop, slot.bodyName, 'VOICE_AK47');
  }, 180_000);
});
