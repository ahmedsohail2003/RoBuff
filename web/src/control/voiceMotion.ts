// Voice motion, the pure part: which way "left" is on the screen, how far a move may go, and
// how long it takes. No DOM and no MuJoCo, so the unit tests can check every number.
//
// Directions:
// - left and right are screen left and right: the camera's right vector laid on the floor.
// - up and down are world z.
// - forward and back are out from and in toward the base axis, along the floor.
// - toward and away (toward me, closer / away from me, further) follow the camera on the floor.

import type { Vec3 } from '../sim/simulation';
import { HAND_WORKSPACE } from './handMapping';
import { clampTarget, type Workspace } from './workspace';

export const VOICE_MOTION = {
  /** Peak speed of a min-jerk move, m/s. The S2 lift peaks at 1.875 x 0.08 m / 1.5 s = 0.10 m/s. */
  peakSpeed: 0.1,
  /** Shortest move, seconds. */
  minMoveS: 0.5,
  /** Hand-back glide speed, m/s, and when it counts as arrived, m. */
  handbackSpeed: 0.1,
  handbackDoneM: 0.005,
  /** The hand's pinch must be this close to the voice grip before it takes the jaw. */
  gripMatch: 0.5,
  /** A grip change by voice takes this long (the jaw slews a full stroke in 0.4 s). */
  gripS: 0.4,
} as const;

/** Peak speed of a min-jerk profile over distance d in time T is 1.875 d / T. */
const MIN_JERK_PEAK = 1.875;

export type MoveDirection = 'left' | 'right' | 'up' | 'down' | 'forward' | 'back' | 'toward' | 'away';
export const MOVE_DIRECTIONS: readonly MoveDirection[] = ['left', 'right', 'up', 'down', 'forward', 'back', 'toward', 'away'];

export interface ScreenAxes {
  /** Screen right, on the floor. */
  right: Vec3;
  /** Away from the viewer, on the floor. */
  away: Vec3;
  up: Vec3;
}

/**
 * OrbitControls' azimuth theta (atan2(dx, -dy) for camera minus target with z up) to floor axes.
 * At the default view theta = 0.6987 rad and right = (0.766, 0.643, 0).
 */
export function screenAxes(theta: number): ScreenAxes {
  return { right: [Math.cos(theta), Math.sin(theta), 0], away: [-Math.sin(theta), Math.cos(theta), 0], up: [0, 0, 1] };
}

/** The unit vector for a direction word, seen from a camera at azimuth theta, for a gripper at `from`. */
export function directionVector(direction: MoveDirection, theta: number, from: Vec3, ws: Workspace = HAND_WORKSPACE): Vec3 {
  const axes = screenAxes(theta);
  const neg = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];
  switch (direction) {
    case 'right':
      return axes.right;
    case 'left':
      return neg(axes.right);
    case 'up':
      return axes.up;
    case 'down':
      return neg(axes.up);
    case 'away':
      return axes.away;
    case 'toward':
      return neg(axes.away);
    case 'forward':
    case 'back': {
      // Radial from the base axis; straight over the axis it is the arm's own forward, -y.
      const rx = from[0] - ws.baseAxis[0];
      const ry = from[1] - ws.baseAxis[1];
      const r = Math.hypot(rx, ry);
      const out: Vec3 = r > 1e-6 ? [rx / r, ry / r, 0] : [0, -1, 0];
      return direction === 'forward' ? out : neg(out);
    }
  }
}

export interface PlannedMove {
  from: Vec3;
  /** Where the move ends, inside the hand workspace. */
  goal: Vec3;
  /** What was asked for, before the clamp. */
  asked: Vec3;
  /** True when the workspace clamp shortened the move by more than 2 mm. */
  clamped: boolean;
  /** Length of the move that will happen, m. */
  distance: number;
  durationS: number;
}

/** Time for a min-jerk move of d metres at the voice peak speed, never under the minimum. */
export function moveDuration(distance: number, peak: number = VOICE_MOTION.peakSpeed): number {
  return Math.max(VOICE_MOTION.minMoveS, (MIN_JERK_PEAK * Math.abs(distance)) / peak);
}

/** A straight move from `from` by `delta`, clamped to the box the hand may reach. */
export function planMove(from: Vec3, delta: Vec3, ws: Workspace = HAND_WORKSPACE): PlannedMove {
  const asked: Vec3 = [from[0] + delta[0], from[1] + delta[1], from[2] + delta[2]];
  const goal = clampTarget(asked, ws);
  const distance = Math.hypot(goal[0] - from[0], goal[1] - from[1], goal[2] - from[2]);
  const shortBy = Math.hypot(asked[0] - goal[0], asked[1] - goal[1], asked[2] - goal[2]);
  return { from, goal, asked, clamped: shortBy > 0.002, distance, durationS: moveDuration(distance) };
}

/** "5 centimetres" / "2.5 centimetres" / "1 centimetre", for spoken lines. */
export function sayCm(cm: number): string {
  const rounded = Math.round(cm * 10) / 10;
  return `${rounded} ${rounded === 1 ? 'centimetre' : 'centimetres'}`;
}

/** Spoken name of a direction. */
export function directionWords(direction: MoveDirection): string {
  return { left: 'left', right: 'right', up: 'up', down: 'down', forward: 'forward', back: 'back', toward: 'toward you', away: 'away from you' }[direction];
}
