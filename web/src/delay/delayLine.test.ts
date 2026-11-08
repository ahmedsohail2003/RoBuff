import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { MjModel } from '@mujoco/mujoco';
import { beforeAll, describe, expect, it } from 'vitest';
import { ArmController } from '../control/armController';
import { ControlLoop } from '../control/controlLoop';
import { worldToPalm } from '../control/handMapping';
import { ArmIk } from '../control/ik';
import type { HandState, InputSource } from '../input/handState';
import { cubePickPlan } from '../input/scene';
import { SyntheticSource } from '../input/syntheticSource';
import { GRIPPER_SITE, meshFilesIn } from '../sim/armXml';
import { ARM_XML, SCENE_XML, compileModel, type ModelFiles } from '../sim/compileModel';
import { registerGravityTarget, setGravity } from '../sim/gravity';
import { loadNode } from '../sim/loadModelNode';
import type { Mujoco } from '../sim/mujocoRuntime';
import { physicsOnlyFiles } from '../sim/physicsScene';
import { Simulation, type Vec3 } from '../sim/simulation';
import { DelayLine, ONE_WAY_DELAY_S } from './delayLine';
import { DelayRig, GHOST_ROCK, ROCK_BODY, TRUTH_ROCK, rockOnModel, type RockParams } from './dualSim';
import { distanceMm } from './ghostError';

const TICK_S = 0.01;
const MODEL_DIR = path.resolve(import.meta.dirname, '../../public/models/so_arm100');

describe('DelayLine', () => {
  it('reads the newest entry at or before a time, and nothing before the first', () => {
    const line = new DelayLine<number>(4);
    expect(line.read(1)).toBeNull();
    for (let i = 0; i < 6; i++) line.push(i * 0.5, i);
    // Capacity 4: entries 2..5 remain (t = 1.0 .. 2.5).
    expect(line.size).toBe(4);
    expect(line.oldest()).toEqual({ t: 1, value: 2 });
    expect(line.read(2.2)).toEqual({ t: 2, value: 4 });
    expect(line.read(2.5)).toEqual({ t: 2.5, value: 5 });
    expect(line.read(0.9)).toBeNull();
    line.clear();
    expect(line.read(10)).toBeNull();
  });

  it('refuses a time that goes backwards', () => {
    const line = new DelayLine<number>(4);
    line.push(1, 1);
    expect(() => line.push(0.5, 2)).toThrow(/backwards/);
  });
});

let mujoco: Mujoco;
let fullModel: MjModel;
let files: ModelFiles;

beforeAll(async () => {
  ({ mujoco, model: fullModel } = await loadNode());
  const read = (file: string) => readFileSync(path.join(MODEL_DIR, file));
  const armXml = read(ARM_XML).toString('utf8');
  const meshPaths = meshFilesIn(armXml).map((file) => `assets/${file}`);
  files = { armXml, sceneXml: read(SCENE_XML).toString('utf8'), meshes: new Map(meshPaths.map((p) => [p, new Uint8Array(read(p))])) };
  // Every trial runs at Moon gravity (evidence report §4).
  setGravity('moon');
}, 60_000);

/** A truth loop on the full model and a rig whose ghost compiles the physics-only copy, as in the browser. */
function makeRig(ghostRock: RockParams = GHOST_ROCK, truthRock: RockParams = TRUTH_ROCK): DelayRig {
  const sim = new Simulation(mujoco, fullModel);
  const loop = new ControlLoop(sim, new ArmController(sim, new ArmIk(mujoco, fullModel, GRIPPER_SITE)));
  registerGravityTarget('live', () => loop.sim.model);
  loop.source = new SyntheticSource(() => cubePickPlan(sim));
  return new DelayRig(mujoco, loop, () => compileModel(mujoco, physicsOnlyFiles(files)), ghostRock, truthRock);
}

/** Holds the palm at one place, then jumps it at stepAtS. */
class StepSource implements InputSource {
  readonly kind = 'mouse';
  constructor(
    private readonly before: Vec3,
    private readonly after: Vec3,
    private readonly stepAtS: number,
  ) {}
  poll(tMs: number): HandState {
    return { palm: worldToPalm(tMs / 1000 < this.stepAtS ? this.before : this.after), pinch: 0, confidence: 1, tMs };
  }
  reset(): void {}
  describe(): Record<string, unknown> {
    return {};
  }
  dispose(): void {}
}

describe('Earth-Moon delay rig', () => {
  it('a step input reaches the truth controller 1.28 s later (within one control tick), and the view line shows poses 1.28 s old', async () => {
    const rig = makeRig();
    const before: Vec3 = [0, -0.2, 0.12];
    const after: Vec3 = [0.05, -0.2, 0.12];
    rig.loop.source = new StepSource(before, after, 1.0);
    await rig.setMode('moon_ghost_off');
    let reachedAt: number | null = null;
    const truthX: { t: number; x: number }[] = [];
    let viewLagWorst = 0;
    rig.listeners.add((tick) => {
      const target = tick.truth === rig.loop.sim ? rig.loop.controller.status().target : null;
      if (reachedAt === null && target && Math.abs(target[0] - after[0]) < 1e-6) reachedAt = tick.t;
      // Body 6 is a moving arm link: its x at this tick, to compare with the drawn pose later.
      truthX.push({ t: tick.t, x: tick.truth.bodyPoses().xpos[3 * 6]! });
      const view = rig.viewPoses();
      const old = truthX.find((s) => Math.abs(s.t - (tick.t - ONE_WAY_DELAY_S)) < 1e-6);
      if (view && old) viewLagWorst = Math.max(viewLagWorst, Math.abs(view.xpos[3 * 6]! - old.x));
    });
    while (rig.loop.sim.time < 4) rig.advance(10);
    console.log(`DELAY_STEP reached truth controller at ${reachedAt} s for a step sent at 1.000 s; view-line worst mismatch ${viewLagWorst} m`);
    expect(reachedAt).not.toBeNull();
    expect(Math.abs(reachedAt! - (1.0 + ONE_WAY_DELAY_S))).toBeLessThanOrEqual(TICK_S + 1e-9);
    // The drawn pose equals the truth pose recorded 1.28 s earlier, exactly (it is a copy).
    expect(viewLagWorst).toBe(0);
    rig.dispose();
  }, 60_000);

  /** Runs the synthetic pick in Moon-ghost-on and pairs truth at t with the ghost at t - 1.28 s. */
  async function pairedPick(rig: DelayRig, seconds: number) {
    await rig.setMode('moon_ghost_on');
    const ghostAt = new Map<number, { gripper: Vec3; rock: Vec3 }>();
    let maxGripperMm = 0;
    let maxRockMm = 0;
    let maxRockGraspMm = 0;
    let maxMeterMm = 0;
    let truthRockRise = 0;
    const restZ = rig.loop.sim.getBodyPos(ROCK_BODY)![2];
    rig.listeners.add((tick) => {
      const key = Math.round(tick.t / TICK_S);
      ghostAt.set(key, { gripper: tick.ghost!.getSitePos(GRIPPER_SITE)!, rock: tick.ghost!.getBodyPos(ROCK_BODY)! });
      const matched = ghostAt.get(key - Math.round(ONE_WAY_DELAY_S / TICK_S));
      const truthRock = tick.truth.getBodyPos(ROCK_BODY)!;
      truthRockRise = Math.max(truthRockRise, truthRock[2] - restZ);
      if (tick.error) maxMeterMm = Math.max(maxMeterMm, tick.error.gripper_mm, tick.error.rock_mm ?? 0);
      if (!matched) return;
      maxGripperMm = Math.max(maxGripperMm, distanceMm(tick.truth.getSitePos(GRIPPER_SITE)!, matched.gripper));
      const rockMm = distanceMm(truthRock, matched.rock);
      maxRockMm = Math.max(maxRockMm, rockMm);
      const jaws = tick.truth.contactsOf(ROCK_BODY).filter((c) => /Jaw/.test(c.body1) || /Jaw/.test(c.body2)).length;
      if (jaws > 0) maxRockGraspMm = Math.max(maxRockGraspMm, rockMm);
    });
    while (rig.loop.sim.time < seconds) rig.advance(10);
    return { maxGripperMm, maxRockMm, maxRockGraspMm, maxMeterMm, truthRockRiseMm: truthRockRise * 1000 };
  }

  it('with identical parameters the ghost and the truth gripper agree within 1 mm over a 10 s synthetic pick', async () => {
    const rig = makeRig(TRUTH_ROCK, TRUTH_ROCK);
    const run = await pairedPick(rig, 10 + ONE_WAY_DELAY_S);
    console.log(`DELAY_IDENTICAL ${JSON.stringify(run)}`);
    expect(run.maxGripperMm).toBeLessThan(1);
    rig.dispose();
  }, 120_000);

  it('with the hidden mismatch the rock error during the grasp is above zero, and is recorded', async () => {
    const original = rockOnModel(mujoco, fullModel);
    const rig = makeRig();
    const run = await pairedPick(rig, 12 + ONE_WAY_DELAY_S);
    // Read after pairedPick's setMode, which writes the truth rock onto the shared model.
    const truthRock = rockOnModel(mujoco, rig.loop.sim.model);
    const ghostRock = rockOnModel(mujoco, rig.ghostSim!.model);
    console.log(`DELAY_MISMATCH truth rock ${JSON.stringify(truthRock)} ghost rock ${JSON.stringify(ghostRock)} ${JSON.stringify(run)}`);
    expect(truthRock).toEqual({ mass_g: expect.closeTo(62.1, 1), friction: 0.6, priority: 1 });
    expect(ghostRock).toEqual({ mass_g: expect.closeTo(43.2, 1), friction: 0.8, priority: 1 });
    expect(run.maxRockGraspMm).toBeGreaterThan(0);
    expect(run.truthRockRiseMm).toBeGreaterThan(48);
    rig.dispose();
    // dispose gives the shared model its own rock back, so the next test starts clean.
    console.log(`DELAY_DISPOSE rock before ${JSON.stringify(original)} after ${JSON.stringify(rockOnModel(mujoco, fullModel))}`);
    expect(rockOnModel(mujoco, fullModel)).toEqual(original);
  }, 120_000);
});
