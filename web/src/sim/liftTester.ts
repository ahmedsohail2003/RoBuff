// The simulated lift test: the only step that can turn a receipt into PASS. It runs headless
// on a second MjData of the same compiled model as the live scene, at that model's gravity,
// with the arm code S2 verified (ArmController: workspace clamp, smoothing, damped least
// squares IK, gravity feedforward, grip slew), from the object's settled pose.
// Steps: open the jaw to width + 16 mm, descend, close, lift 80 mm, hold 1 s.

import { ArmController } from '../control/armController';
import { closingYawFor } from '../control/grasp';
import { ArmIk } from '../control/ik';
import { minJerk } from '../input/pickScript';
import type { LiftRequest, LiftResult, LiftTester } from '../objects/lift';
import { FIXED_PAD_SITE, GRIPPER_SITE, MOVING_PAD_SITE } from './armXml';
import type { Mujoco } from './mujocoRuntime';
import { alongJaw, freeJointOf, GRIP_POINT_ABOVE_SITE, graspSiteForFrame, turnBodyAboutCom, worldPointsOfBody } from './objectSlot';
import { ARM_JOINTS, Simulation, type Vec3 } from './simulation';

/** Research pipeline step 10: open the jaw to the object's width plus this. */
export const JAW_EXTRA_OPENING = 0.016;
/** S2's gap between the fixed pad and the object on the way down (input/pickScript.ts). */
export const LIFT_CLEARANCE = 0.003;
/** S2's approach height above the grasp (input/pickScript.ts). */
export const APPROACH_HEIGHT = 0.07;
/** Control period: 5 physics steps, as in ControlLoop. */
const STEPS_PER_TICK = 5;
/** Yield to the page after this much wall time, so the test never freezes the tab. */
const SLICE_MS = 12;

export type LiftPhaseName = 'above' | 'down' | 'close' | 'lift' | 'hold';

export interface LiftPhase {
  name: LiftPhaseName;
  waypoint: Vec3;
  /** Grip at the end of the phase, 0 open .. 1 closed; it ramps over the move. */
  grip: number;
  moveS: number;
  dwellS: number;
}

/** The timeline of one lift attempt. Move and dwell times are S2's (input/pickScript.ts); the hold is the research's 1 s. */
export function liftPhases(grasp: Vec3, openGrip: number, liftHeight: number, holdS = 1): LiftPhase[] {
  const above: Vec3 = [grasp[0], grasp[1], grasp[2] + APPROACH_HEIGHT];
  const lifted: Vec3 = [grasp[0], grasp[1], grasp[2] + liftHeight];
  return [
    { name: 'above', waypoint: above, grip: openGrip, moveS: 2, dwellS: 0.6 },
    { name: 'down', waypoint: grasp, grip: openGrip, moveS: 1.5, dwellS: 0.7 },
    { name: 'close', waypoint: grasp, grip: 1, moveS: 0.6, dwellS: 0.8 },
    { name: 'lift', waypoint: lifted, grip: 1, moveS: 1.5, dwellS: 0.6 },
    { name: 'hold', waypoint: lifted, grip: 1, moveS: 0, dwellS: holdS },
  ];
}

/** Target and grip at time t along the phases, from a start point and grip. Null once the last phase ends. */
export function sampleLift(phases: readonly LiftPhase[], start: Vec3, startGrip: number, t: number): { target: Vec3; grip: number; phase: LiftPhaseName } | null {
  let from = start;
  let fromGrip = startGrip;
  let phaseStart = 0;
  for (const phase of phases) {
    const end = phaseStart + phase.moveS + phase.dwellS;
    if (t < end) {
      const s = phase.moveS > 0 ? minJerk((t - phaseStart) / phase.moveS) : 1;
      return {
        target: [0, 1, 2].map((k) => from[k]! + (phase.waypoint[k]! - from[k]!) * s) as Vec3,
        grip: fromGrip + (phase.grip - fromGrip) * s,
        phase: phase.name,
      };
    }
    from = phase.waypoint;
    fromGrip = phase.grip;
    phaseStart = end;
  }
  return null;
}

export interface LiftSample {
  t: number;
  phase: LiftPhaseName;
  /** Centre of mass height above where it rested, metres. */
  rise: number;
  /** Grip command fully closed. */
  closed: boolean;
}

export interface LiftScore {
  /** Rise at the end of the hold, metres. This is what the pass rule reads. */
  rise: number;
  maxRise: number;
  /** Longest stretch with the grip closed and the rise at least passRise, seconds. */
  holdS: number;
}

/** Scores an attempt. The rise that counts is the one at the end of the hold: a drop during the hold is a fail. */
export function scoreLift(samples: readonly LiftSample[], passRise: number): LiftScore {
  if (samples.length === 0) return { rise: 0, maxRise: 0, holdS: 0 };
  let maxRise = -Infinity;
  let holdS = 0;
  let runStart: number | null = null;
  for (const sample of samples) {
    maxRise = Math.max(maxRise, sample.rise);
    if (sample.closed && sample.rise >= passRise) {
      runStart ??= sample.t;
      holdS = Math.max(holdS, sample.t - runStart);
    } else {
      runStart = null;
    }
  }
  const last = samples[samples.length - 1]!;
  return { rise: Number.isFinite(last.rise) ? last.rise : 0, maxRise: Number.isFinite(maxRise) ? maxRise : 0, holdS };
}

/** Jaw angle that leaves a clear gap between the tip pads, by bisection on the jaw's kinematics. Clamped to the joint's range. */
export function jawAngleForGap(mujoco: Mujoco, sim: Simulation, gap: number): number {
  const data = sim.mjData;
  const qpos = data.qpos as Float64Array;
  const jaw = ARM_JOINTS.length - 1;
  const saved = qpos[jaw]!;
  const [closed, open] = sim.jawRange();
  const gapAt = (angle: number): number => {
    qpos[jaw] = angle;
    mujoco.mj_kinematics(sim.model, data);
    const a = sim.getSitePos(FIXED_PAD_SITE)!;
    const b = sim.getSitePos(MOVING_PAD_SITE)!;
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  };
  let angle: number;
  if (gap >= gapAt(open)) angle = open;
  else if (gap <= gapAt(closed)) angle = closed;
  else {
    let lo = closed;
    let hi = open;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (gapAt(mid) < gap) lo = mid;
      else hi = mid;
    }
    angle = (lo + hi) / 2;
  }
  qpos[jaw] = saved;
  mujoco.mj_forward(sim.model, data);
  return angle;
}

export interface LiftRun {
  yaw_deg: number;
  /** How far the object was turned about its centre of mass so this yaw meets the jaw, degrees. */
  turn_deg: number;
  width_mm: number;
  jaw_gap_mm: number;
  open_grip: number;
  grasp_site: Vec3;
  rise_mm: number;
  max_rise_mm: number;
  hold_s: number;
  jaws_touching: string[];
  sim_s: number;
  physics_steps: number;
  wall_ms: number;
  /** Longest stretch the test ran without giving the page a turn, ms. */
  longest_block_ms: number;
}

const yieldToPage = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export interface ArmLiftTesterOptions {
  /** The live simulation whose arm state each attempt starts from. Its model is the one tested. */
  live: () => Simulation;
  bodyName: string;
  /** Lift hold time, seconds. Research: 1 s. */
  holdS?: number;
  /** Called as each attempt starts, counting from 1. */
  onAttempt?: (attempt: number, yawDeg: number) => void;
}

export class ArmLiftTester implements LiftTester {
  readonly name = 'headless MuJoCo lift test (second MjData on the live model, S2 arm controller)';
  readonly runs: LiftRun[] = [];

  constructor(
    private readonly mujoco: Mujoco,
    private readonly options: ArmLiftTesterOptions,
  ) {}

  async testLift(request: LiftRequest): Promise<LiftResult> {
    if (request.yaw_frame !== 'rest-world' || !request.rest || request.rest.scene !== 'arena') {
      throw new Error('the arm lift test needs the rest pose from the live scene');
    }
    this.options.onAttempt?.(this.runs.length + 1, request.yaw_deg);
    const wallStart = performance.now();
    let sliceStart = wallStart;
    let longestBlock = 0;
    const live = this.options.live();
    const model = live.model;
    const sim = new Simulation(this.mujoco, model);
    const ik = new ArmIk(this.mujoco, model, GRIPPER_SITE);
    try {
      // Same state as the live scene: arm as it is now, object where it came to rest.
      const data = sim.mjData;
      (data.qpos as Float64Array).set(live.mjData.qpos as Float64Array);
      (data.qvel as Float64Array).fill(0);
      (data.ctrl as Float64Array).set(live.mjData.ctrl as Float64Array);
      const { qadr, body } = freeJointOf(this.mujoco, sim, this.options.bodyName);
      (data.qpos as Float64Array).set([...request.rest.position_m, ...request.rest.quat], qadr);
      this.mujoco.mj_forward(model, data);

      // Turn the object so the requested yaw lines up with the heading S2's controller gives the jaw.
      const xipos = data.xipos as Float64Array;
      const heading = closingYawFor([xipos[3 * body]!, xipos[3 * body + 1]!, 0]);
      const turn = wrapHalfTurn(heading - (request.yaw_deg * Math.PI) / 180);
      if (Math.abs(turn) > 1e-9) turnBodyAboutCom(this.mujoco, sim, this.options.bodyName, turn);

      const com = data.xipos as Float64Array;
      const frame = alongJaw(worldPointsOfBody(this.mujoco, sim, this.options.bodyName), heading, [com[3 * body]!, com[3 * body + 1]!]);
      const width = frame.halfWidth * 2;
      const siteZ = request.grip_z_mm / 1000 + frame.lowest - GRIP_POINT_ABOVE_SITE;
      const grasp = graspSiteForFrame(frame, siteZ, LIFT_CLEARANCE);
      const gap = width + JAW_EXTRA_OPENING;
      const [closed, open] = sim.jawRange();
      const openGrip = (open - jawAngleForGap(this.mujoco, sim, gap)) / (open - closed);

      const controller = new ArmController(sim, ik);
      const phases = liftPhases(grasp, openGrip, request.lift_height_mm / 1000, this.options.holdS ?? 1);
      const start = sim.getSitePos(GRIPPER_SITE)!;
      const startGrip = Math.min(1, Math.max(0, (open - (data.ctrl as Float64Array)[ARM_JOINTS.length - 1]!) / (open - closed)));
      const restZ = (data.xipos as Float64Array)[3 * body + 2]!;
      const passRise = request.pass_rise_mm / 1000;
      const samples: LiftSample[] = [];
      const dt = STEPS_PER_TICK * sim.timestep;
      let t = 0;
      let steps = 0;
      for (;;) {
        const command = sampleLift(phases, start, startGrip, t);
        if (!command) break;
        controller.setTarget(command.target);
        controller.setGrip(command.grip);
        controller.tick(dt);
        sim.step(STEPS_PER_TICK);
        steps += STEPS_PER_TICK;
        t += dt;
        // Re-read the view each time: WASM memory can grow and detach an old one.
        const z = (data.xipos as Float64Array)[3 * body + 2]!;
        if (!Number.isFinite(z)) break;
        samples.push({ t, phase: command.phase, rise: z - restZ, closed: command.grip >= 0.999 });
        const now = performance.now();
        if (now - sliceStart > SLICE_MS) {
          longestBlock = Math.max(longestBlock, now - sliceStart);
          await yieldToPage();
          sliceStart = performance.now();
        }
      }
      longestBlock = Math.max(longestBlock, performance.now() - sliceStart);
      const score = scoreLift(samples, passRise);
      const touching = [...new Set(sim.contactsOf(this.options.bodyName).flatMap((c) => [c.body1, c.body2]).filter((name) => name === 'Fixed_Jaw' || name === 'Moving_Jaw'))].sort();
      const wallMs = performance.now() - wallStart;
      const run: LiftRun = {
        yaw_deg: request.yaw_deg,
        turn_deg: (turn * 180) / Math.PI,
        width_mm: width * 1000,
        jaw_gap_mm: gap * 1000,
        open_grip: openGrip,
        grasp_site: grasp,
        rise_mm: score.rise * 1000,
        max_rise_mm: score.maxRise * 1000,
        hold_s: score.holdS,
        jaws_touching: touching,
        sim_s: t,
        physics_steps: steps,
        wall_ms: wallMs,
        longest_block_ms: longestBlock,
      };
      this.runs.push(run);
      const jaws = touching.length === 2 ? 'both jaws on it at the end' : touching.length === 1 ? `only ${touching[0]} on it at the end` : 'no jaw on it at the end';
      return {
        simulated: true,
        rise_mm: run.rise_mm,
        hold_s: run.hold_s,
        wall_ms: wallMs,
        note: `jaw opened to ${(gap * 1000).toFixed(1)} mm for ${(width * 1000).toFixed(1)} mm, held ${score.holdS.toFixed(2)} s at ${request.pass_rise_mm.toFixed(0)} mm or more, ${jaws}; ${steps} physics steps in ${wallMs.toFixed(0)} ms.`,
      };
    } finally {
      ik.dispose();
      sim.mjData.delete();
    }
  }
}

/** An angle folded into (-90, 90] degrees: a jaw axis is the same line after a half turn. */
function wrapHalfTurn(radians: number): number {
  let a = radians;
  while (a > Math.PI / 2) a -= Math.PI;
  while (a <= -Math.PI / 2) a += Math.PI;
  return a;
}
