import type { HandState } from '../input/handState';
import type { Vec3 } from '../sim/simulation';
import { ARM_WORKSPACE, clampTarget, type Workspace } from './workspace';

/**
 * Linear map between hand space (image x, y in 0..1 with y down, depth 0 far .. 1 near
 * the camera) and the gripper target in world metres. The view is mirrored, like a selfie:
 * moving the hand to the right of the image moves the arm toward -x. Raising the hand
 * raises the gripper; bringing it closer to the camera reaches farther out (-y).
 */
export const HAND_TO_WORLD = {
  xCenter: 0,
  xSpan: 0.5,
  zLow: 0.01,
  zSpan: 0.25,
  yNear: -0.1,
  ySpan: 0.3,
} as const;

/** Below this confidence a hand state is ignored and the arm holds its last target. */
export const MIN_CONFIDENCE = 0.5;

export function palmToWorld(palm: Vec3): Vec3 {
  const m = HAND_TO_WORLD;
  return [m.xCenter + (0.5 - palm[0]) * m.xSpan, m.yNear - palm[2] * m.ySpan, m.zLow + (1 - palm[1]) * m.zSpan];
}

/** Inverse of palmToWorld, for scripted hands that want to reach a given point. */
export function worldToPalm(world: Vec3): Vec3 {
  const m = HAND_TO_WORLD;
  return [0.5 - (world[0] - m.xCenter) / m.xSpan, 1 - (world[2] - m.zLow) / m.zSpan, (m.yNear - world[1]) / m.ySpan];
}

/**
 * Where a hand may send the gripper: the arm's workspace with 4 cm kept back from full
 * reach and the top cut to 26 cm. The linear map above covers more than the arm can reach
 * (a hand at a corner of the picture maps up to 43 cm from the shoulder, against 33 cm of
 * reach), so without this a hand near the edge pulls the arm out straight.
 */
export const HAND_WORKSPACE: Workspace = { ...ARM_WORKSPACE, maxReach: 0.29, maxZ: 0.26 };

export interface ArmCommand {
  target: Vec3;
  grip: number;
  /** True when the hand was outside HAND_WORKSPACE and the target was pulled back in. */
  clamped: boolean;
}

/** The one mapping from any input source to the arm. Null means hold the last command. */
export function handToCommand(state: HandState): ArmCommand | null {
  if (!(state.confidence >= MIN_CONFIDENCE)) return null;
  if (!state.palm.every(Number.isFinite) || !Number.isFinite(state.pinch)) return null;
  const raw = palmToWorld(state.palm);
  const target = clampTarget(raw, HAND_WORKSPACE);
  const clamped = Math.hypot(raw[0] - target[0], raw[1] - target[1], raw[2] - target[2]) > 1e-9;
  return { target, grip: Math.min(1, Math.max(0, state.pinch)), clamped };
}

/** The hand-to-arm range in words, for the screen. Numbers come from HAND_TO_WORLD and HAND_WORKSPACE. */
export function handRangeText(): string {
  const m = HAND_TO_WORLD;
  const cm = (metres: number) => Math.round(metres * 100);
  return (
    `hand range: ${cm(m.xSpan)} cm side to side, ${cm(m.zLow)}-${cm(Math.min(m.zLow + m.zSpan, HAND_WORKSPACE.maxZ))} cm high, ` +
    `${cm(-m.yNear)}-${cm(-(m.yNear - m.ySpan))} cm out; kept within ${cm(HAND_WORKSPACE.maxReach)} cm of the shoulder ` +
    `(arm reach ${cm(ARM_WORKSPACE.maxReach)} cm)`
  );
}
