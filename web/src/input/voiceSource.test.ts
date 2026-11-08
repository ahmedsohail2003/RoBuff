// The voice source on the real MuJoCo arm (Node, loadNode): moves by the amount asked in the
// screen direction asked, stops dead on the latch, parks and restores across Moon mode switches,
// and hands the arm back without dropping what it holds.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { MjModel } from '@mujoco/mujoco';
import { beforeAll, describe, expect, it } from 'vitest';
import { ArmController } from '../control/armController';
import { ControlLoop } from '../control/controlLoop';
import { palmToWorld, worldToPalm } from '../control/handMapping';
import { ArmIk } from '../control/ik';
import { directionVector, planMove, screenAxes } from '../control/voiceMotion';
import { DelayRig, DelayedSource, operatorSource, setOperatorSource } from '../delay/dualSim';
import { DEFAULT_VIEW } from '../render/defaultView';
import { StopLatch } from '../safety/latch';
import { GRIPPER_SITE, meshFilesIn } from '../sim/armXml';
import { ARM_XML, SCENE_XML, compileModel, type ModelFiles } from '../sim/compileModel';
import { loadNode } from '../sim/loadModelNode';
import type { Mujoco } from '../sim/mujocoRuntime';
import { physicsOnlyFiles } from '../sim/physicsScene';
import { Simulation, type Vec3 } from '../sim/simulation';
import type { HandState, InputSource } from './handState';
import { VoiceSource } from './voiceSource';

const MODEL_DIR = path.resolve(import.meta.dirname, '../../public/models/so_arm100');
let mujoco: Mujoco;
let model: MjModel;
let files: ModelFiles;

beforeAll(async () => {
  ({ mujoco, model } = await loadNode());
  const read = (file: string) => readFileSync(path.join(MODEL_DIR, file));
  const armXml = read(ARM_XML).toString('utf8');
  const meshPaths = meshFilesIn(armXml).map((file) => `assets/${file}`);
  files = { armXml, sceneXml: read(SCENE_XML).toString('utf8'), meshes: new Map(meshPaths.map((p) => [p, new Uint8Array(read(p))])) };
}, 60_000);

/** OrbitControls' theta for the default view: atan2(dx, -dy) of camera minus target. */
const DEFAULT_THETA = Math.atan2(DEFAULT_VIEW.position[0] - DEFAULT_VIEW.target[0], -(DEFAULT_VIEW.position[1] - DEFAULT_VIEW.target[1]));

function makeLoop(): ControlLoop {
  const sim = new Simulation(mujoco, model);
  const loop = new ControlLoop(sim, new ArmController(sim, new ArmIk(mujoco, model, GRIPPER_SITE)));
  loop.stopLatch = new StopLatch();
  return loop;
}

/** A hand held at one point with one pinch, switchable from the test. */
class HeldHand implements InputSource {
  readonly kind = 'mouse' as const;
  resets = 0;
  constructor(
    public at: Vec3,
    public pinch: number,
  ) {}
  poll(tMs: number): HandState {
    return { palm: worldToPalm(this.at), pinch: this.pinch, confidence: 1, tMs };
  }
  reset(): void {
    this.resets++;
  }
  describe(): Record<string, unknown> {
    return {};
  }
  dispose(): void {}
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): number => Math.hypot(...a);

describe('voice source', () => {
  it('(b) worldToPalm is the exact inverse of palmToWorld', () => {
    let worst = 0;
    for (const p of [[0, -0.24, 0.08], [0.1, -0.3, 0.2], [-0.15, -0.12, 0.02], [0.33, 0.1, -0.4]] as Vec3[]) {
      const back = palmToWorld(worldToPalm(p));
      worst = Math.max(worst, norm(sub(back, p)));
      const palm: Vec3 = [0.3, 0.7, 0.45];
      worst = Math.max(worst, norm(sub(worldToPalm(palmToWorld(palm)), palm)));
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it('screen axes at the default view: right is (0.766, 0.643, 0)', () => {
    expect(DEFAULT_THETA).toBeCloseTo(0.6987, 3);
    const { right, away } = screenAxes(DEFAULT_THETA);
    expect(right[0]).toBeCloseTo(0.766, 3);
    expect(right[1]).toBeCloseTo(0.643, 3);
    expect(dot(right, away)).toBeCloseTo(0, 12);
  });

  it('(c) a 5 cm "left" move moves the target 50 +/- 2 mm along screen left, and the gripper follows', async () => {
    const loop = makeLoop();
    const voice = new VoiceSource(loop, { parked: null });
    loop.source = voice;
    loop.advance(250); // 0.5 s holding at the seed
    const startTarget = loop.controller.status().target!;
    const startSite = loop.sim.getSitePos(GRIPPER_SITE)!;
    const plan = planMove(voice.endGoal(), directionVector('left', DEFAULT_THETA, voice.endGoal()).map((v) => v * 0.05) as Vec3);
    let outcome: string | null = null;
    void voice.moveTo(plan.goal, plan.durationS, 'left 5 cm').then((o) => (outcome = o));
    let peak = 0;
    let last = startSite;
    const end = loop.sim.time + plan.durationS + 0.8;
    while (loop.sim.time < end) {
      loop.advance(5);
      const site = loop.sim.getSitePos(GRIPPER_SITE)!;
      peak = Math.max(peak, norm(sub(site, last)) / 0.01);
      last = site;
    }
    const left: Vec3 = screenAxes(DEFAULT_THETA).right.map((v) => -v) as Vec3;
    const moved = sub(loop.controller.status().target!, startTarget);
    const siteMoved = sub(loop.sim.getSitePos(GRIPPER_SITE)!, startSite);
    console.log(`VOICE_MOVE target ${(dot(moved, left) * 1000).toFixed(2)} mm along screen left (across ${(norm(sub(moved, left.map((v) => v * dot(moved, left)) as Vec3)) * 1000).toFixed(2)} mm); site ${(dot(siteMoved, left) * 1000).toFixed(2)} mm; peak site speed ${peak.toFixed(3)} m/s; ${plan.durationS.toFixed(2)} s`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outcome).toBe('done');
    expect(Math.abs(dot(moved, left) * 1000 - 50)).toBeLessThanOrEqual(2);
    expect(norm(sub(moved, left.map((v) => v * dot(moved, left)) as Vec3)) * 1000).toBeLessThan(2);
    expect(Math.abs(dot(siteMoved, left) * 1000 - 50)).toBeLessThanOrEqual(3);
    expect(peak).toBeLessThanOrEqual(0.12);
    expect(voice.state).toBe('holding');
  });

  it('(d) a stop mid-move clears the queue, the target stops changing, and nothing resumes after Resume', async () => {
    const loop = makeLoop();
    const voice = new VoiceSource(loop, { parked: null });
    loop.source = voice;
    loop.advance(50);
    const from = voice.endGoal();
    let first: string | null = null;
    let second: string | null = null;
    void voice.moveTo([from[0] + 0.08, from[1], from[2]], 1.5, 'first').then((o) => (first = o));
    void voice.moveTo([from[0] + 0.08, from[1], from[2] + 0.05], 1.0, 'second').then((o) => (second = o));
    loop.advance(300); // 0.6 s into the first move
    loop.stopLatch!.stop('test', loop.sim.time);
    const ctrlAtStop = loop.sim.getCtrl();
    const goalAtStop = [...voice.goal];
    const siteAtStop = loop.sim.getSitePos(GRIPPER_SITE)!;
    const tAtStop = loop.sim.time;
    const targets: number[] = [];
    let drift05 = 0;
    for (let i = 0; i < 100; i++) {
      loop.advance(10);
      targets.push(norm(sub(voice.goal, goalAtStop as Vec3)));
      if (loop.sim.time - tAtStop <= 0.5 + 1e-9) drift05 = Math.max(drift05, norm(sub(loop.sim.getSitePos(GRIPPER_SITE)!, siteAtStop)));
    }
    // The brake: over the next 0.5 s the site moves less than 2 mm (the plan's stop criterion).
    console.log(`VOICE_STOP_BRAKE site moved at most ${(drift05 * 1000).toFixed(2)} mm in the 0.5 s after the stop`);
    expect(drift05 * 1000).toBeLessThan(2);
    expect(loop.sim.getCtrl()).toEqual(ctrlAtStop);
    expect(Math.max(...targets)).toBe(0);
    expect(voice.busy).toBe(false);
    loop.stopLatch!.clear();
    loop.advance(500);
    expect(norm(sub(voice.goal, goalAtStop as Vec3))).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    console.log(`VOICE_STOP outcomes ${first} ${second}; goal moved ${Math.max(...targets)} m while stopped and after Resume`);
    expect(first).toBe('cancelled');
    expect(second).toBe('cancelled');
  });

  it('(e) the Moon helpers park and restore the operator source across mode switches without throwing', async () => {
    const loop = makeLoop();
    const hand = new HeldHand([0, -0.22, 0.1], 0);
    loop.source = hand;
    const rig = new DelayRig(mujoco, loop, () => compileModel(mujoco, physicsOnlyFiles(files)));
    await rig.setMode('moon_ghost_on');
    rig.advance(500);
    expect(loop.source).toBeInstanceOf(DelayedSource);
    const voice = new VoiceSource(loop, { parked: operatorSource(loop) });
    setOperatorSource(loop, voice);
    expect(loop.source).toBeInstanceOf(DelayedSource);
    expect(operatorSource(loop)).toBe(voice);
    void voice.moveTo([0, -0.22, 0.15], 1, 'up');
    rig.advance(500);
    // A mode switch while voice holds the seat: today's takeArm froze physics here ("time went backwards").
    await rig.setMode('moon_ghost_off');
    expect(operatorSource(loop)).toBe(voice);
    expect(() => rig.advance(500)).not.toThrow();
    setOperatorSource(loop, voice.parked);
    expect(operatorSource(loop)).toBe(hand);
    await rig.setMode('direct');
    expect(loop.source).toBe(hand);
    expect(() => rig.advance(500)).not.toThrow();
    await rig.setMode('moon_ghost_off');
    expect(() => rig.advance(500)).not.toThrow();
    expect(hand.resets).toBeGreaterThan(0);
    rig.dispose();
  });

  it('in a Moon mode a voice move reaches the true controller 1.28 s later and the ghost at once', async () => {
    const loop = makeLoop();
    loop.source = new HeldHand([0, -0.22, 0.1], 0);
    const rig = new DelayRig(mujoco, loop, () => compileModel(mujoco, physicsOnlyFiles(files)));
    await rig.setMode('moon_ghost_on');
    rig.advance(1000);
    const voice = new VoiceSource(loop, { parked: operatorSource(loop) });
    setOperatorSource(loop, voice);
    rig.advance(5);
    const sentAt = loop.sim.time;
    const z0 = voice.goal[2];
    void voice.moveTo([voice.goal[0], voice.goal[1], z0 + 0.05], 1, 'up');
    let truthAt: number | null = null;
    let ghostAt: number | null = null;
    const ghostStart = rig.ghostSim!.getSitePos(GRIPPER_SITE)![2];
    const truthStart = loop.controller.status().target![2];
    while (loop.sim.time < sentAt + 3) {
      rig.advance(5);
      if (truthAt === null && loop.controller.status().target![2] > truthStart + 0.001) truthAt = loop.sim.time;
      if (ghostAt === null && rig.ghostSim!.getSitePos(GRIPPER_SITE)![2] > ghostStart + 0.001) ghostAt = loop.sim.time;
    }
    console.log(`VOICE_MOON sent ${sentAt.toFixed(3)} s; ghost moved 1 mm at ${ghostAt?.toFixed(3)} s; truth target moved 1 mm at ${truthAt?.toFixed(3)} s`);
    expect(ghostAt! - sentAt).toBeLessThan(0.6);
    expect(truthAt! - sentAt).toBeGreaterThanOrEqual(1.28);
    rig.dispose();
  });

  it('(f) hand-back glides at 0.10 m/s and keeps the voice grip until the hand pinch agrees', () => {
    const loop = makeLoop();
    const hand = new HeldHand([0.08, -0.22, 0.12], 0);
    let backTo: InputSource | null = null;
    const voice = new VoiceSource(loop, { parked: hand, onHandBack: (parked) => setOperatorSource(loop, (backTo = parked)) });
    loop.source = voice;
    void voice.setGrip(1, 'close');
    loop.advance(500);
    expect(voice.grip).toBe(1);
    voice.handBack();
    let peak = 0;
    let last = voice.goal;
    // The hand stays open for 2 s: the glide arrives, but the grip must not open.
    for (let i = 0; i < 200; i++) {
      loop.advance(5);
      peak = Math.max(peak, norm(sub(voice.goal, last)) / 0.01);
      last = [...voice.goal] as Vec3;
      expect(loop.controller.status().grip).toBe(1);
    }
    expect(loop.source).toBe(voice);
    expect(norm(sub(voice.goal, hand.at))).toBeLessThan(0.001);
    hand.pinch = 1;
    loop.advance(20);
    expect(backTo).toBe(hand);
    expect(loop.source).toBe(hand);
    expect(loop.controller.status().grip).toBe(1);
    console.log(`VOICE_HANDBACK peak glide ${peak.toFixed(3)} m/s; handed back once the pinch agreed`);
    expect(peak).toBeLessThanOrEqual(0.1 + 1e-9);
  });
});
