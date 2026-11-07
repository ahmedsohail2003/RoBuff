import type { HandState } from '../input/handState';
import type { Vec3 } from '../sim/simulation';

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

export interface ArmCommand {
  target: Vec3;
  grip: number;
}

/** The one mapping from any input source to the arm. Null means hold the last command. */
export function handToCommand(state: HandState): ArmCommand | null {
  if (!(state.confidence >= MIN_CONFIDENCE)) return null;
  if (!state.palm.every(Number.isFinite) || !Number.isFinite(state.pinch)) return null;
  return { target: palmToWorld(state.palm), grip: Math.min(1, Math.max(0, state.pinch)) };
}
