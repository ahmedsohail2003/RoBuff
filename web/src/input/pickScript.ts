import { graspSiteFor } from '../control/grasp';
import type { Vec3 } from '../sim/simulation';

export interface PickPhase {
  name: 'above' | 'down' | 'close' | 'lift' | 'hold' | 'move' | 'open' | 'done';
  /** Gripper site waypoint, reached at the end of the move and held through the dwell. */
  waypoint: Vec3;
  /** Grip at the end of the phase. It ramps from the previous grip over the move time. */
  grip: number;
  moveS: number;
  dwellS: number;
}

export interface PickSample {
  target: Vec3;
  grip: number;
  phaseIndex: number;
  phase: PickPhase['name'];
  waypoint: Vec3;
  /** Seconds since the script started. */
  t: number;
  /** True while the phase is dwelling at its waypoint. */
  settled: boolean;
  done: boolean;
}

export interface PickPlan {
  /** Centre of the box at rest. */
  objectCenter: Vec3;
  objectHalfWidth: number;
  /** Where the gripper site is when the script starts. */
  start: Vec3;
}

/** Gap left between the fixed jaw pad and the box on the way down, in metres. */
const CLEARANCE = 0.003;
/** Tip pads span about 1 cm below the gripper site, so this centres them on a 3 cm box. */
const GRASP_HEIGHT_ABOVE_CENTER = 0.007;
const APPROACH_HEIGHT = 0.07;
const LIFT_HEIGHT = 0.08;
const CARRY_OFFSET: Vec3 = [0.06, 0.02, 0];

/** The scripted pick: above the box, down, close, lift, hold, move, open. */
export function pickPhases(plan: PickPlan): PickPhase[] {
  const grasp = graspSiteFor(plan.objectCenter, plan.objectHalfWidth, CLEARANCE, GRASP_HEIGHT_ABOVE_CENTER);
  const above: Vec3 = [grasp[0], grasp[1], grasp[2] + APPROACH_HEIGHT];
  const lifted: Vec3 = [grasp[0], grasp[1], grasp[2] + LIFT_HEIGHT];
  const carried: Vec3 = [lifted[0] + CARRY_OFFSET[0], lifted[1] + CARRY_OFFSET[1], lifted[2] + CARRY_OFFSET[2]];
  return [
    { name: 'above', waypoint: above, grip: 0, moveS: 2, dwellS: 0.6 },
    { name: 'down', waypoint: grasp, grip: 0, moveS: 1.5, dwellS: 0.7 },
    { name: 'close', waypoint: grasp, grip: 1, moveS: 0.6, dwellS: 0.8 },
    { name: 'lift', waypoint: lifted, grip: 1, moveS: 1.5, dwellS: 0.6 },
    { name: 'hold', waypoint: lifted, grip: 1, moveS: 0, dwellS: 2.5 },
    { name: 'move', waypoint: carried, grip: 1, moveS: 1.5, dwellS: 0.6 },
    { name: 'open', waypoint: carried, grip: 0, moveS: 0.4, dwellS: 1.5 },
    { name: 'done', waypoint: carried, grip: 0, moveS: 0, dwellS: Infinity },
  ];
}

/** Minimum-jerk blend 0..1: zero velocity and acceleration at both ends. The one copy: the lift test and the voice source use it too. */
export function minJerk(s: number): number {
  const u = Math.min(1, Math.max(0, s));
  return u * u * u * (10 - 15 * u + 6 * u * u);
}

export class PickScript {
  readonly phases: PickPhase[];

  constructor(readonly plan: PickPlan) {
    this.phases = pickPhases(plan);
  }

  sample(t: number): PickSample {
    let from = this.plan.start;
    let fromGrip = 0;
    let phaseStart = 0;
    for (let i = 0; i < this.phases.length; i++) {
      const phase = this.phases[i]!;
      const phaseEnd = phaseStart + phase.moveS + phase.dwellS;
      if (t < phaseEnd || i === this.phases.length - 1) {
        const local = t - phaseStart;
        const s = phase.moveS > 0 ? minJerk(local / phase.moveS) : 1;
        return {
          target: [0, 1, 2].map((k) => from[k]! + (phase.waypoint[k]! - from[k]!) * s) as Vec3,
          grip: fromGrip + (phase.grip - fromGrip) * s,
          phaseIndex: i,
          phase: phase.name,
          waypoint: phase.waypoint,
          t,
          settled: local >= phase.moveS,
          done: phase.name === 'done',
        };
      }
      from = phase.waypoint;
      fromGrip = phase.grip;
      phaseStart = phaseEnd;
    }
    throw new Error('unreachable: the last phase never ends');
  }
}
