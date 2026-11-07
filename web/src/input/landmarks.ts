import type { Vec3 } from '../sim/simulation';
import type { Landmark } from './handState';

/** MediaPipe hand landmark indices used here. */
export const WRIST = 0;
export const THUMB_TIP = 4;
export const INDEX_MCP = 5;
export const INDEX_TIP = 8;
export const MIDDLE_MCP = 9;
export const PINKY_MCP = 17;

/**
 * Pinch ratio = d(thumb tip, index tip) / palm size. The gripper closes when the ratio
 * falls below PINCH_CLOSE_BELOW and opens only when it rises above PINCH_OPEN_ABOVE.
 * The gap between the two is the hysteresis. Starting values, to tune on a real hand:
 * the two open hands (thumb resting beside the index finger) in MediaPipe's sample photo
 * measured 0.43 and 0.50, so the open threshold sits below both. A pinch has not been
 * measured on a real hand yet.
 */
export const PINCH_CLOSE_BELOW = 0.25;
export const PINCH_OPEN_ABOVE = 0.38;
/** Ratios the synthetic hand uses for a fully open and a fully pinched hand. */
export const SYNTHETIC_OPEN_RATIO = 1.0;
export const SYNTHETIC_CLOSED_RATIO = 0.15;

/** Palm size in the image (fraction of image height) that maps to depth 0 (far) and 1 (near). Starting values. */
export const PALM_SIZE_FAR = 0.08;
export const PALM_SIZE_NEAR = 0.24;

/** Twenty-one landmarks, every coordinate finite. Anything else is not a hand. */
export function isHand(landmarks: readonly Landmark[] | null | undefined): landmarks is Landmark[] {
  return !!landmarks && landmarks.length === 21 && landmarks.every((point) => point.length === 3 && point.every(Number.isFinite));
}

function at(landmarks: readonly Landmark[], index: number): Landmark {
  const point = landmarks[index];
  if (!point) throw new Error(`hand has no landmark ${index}`);
  return point;
}

/**
 * Distance in units of image height. MediaPipe normalizes x by image width and y by
 * height, and gives z on roughly the same scale as x, so x and z are scaled by the
 * aspect ratio (width / height) to make the three axes comparable.
 */
export function distance(a: Landmark, b: Landmark, aspect = 1): number {
  return Math.hypot((a[0] - b[0]) * aspect, a[1] - b[1], (a[2] - b[2]) * aspect);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Apparent palm size: mean side of the wrist / index knuckle / pinky knuckle triangle.
 * Using three sides keeps it steadier than one bone when the hand tilts about one axis.
 */
export function palmSize(landmarks: readonly Landmark[], aspect = 1): number {
  const wrist = at(landmarks, WRIST);
  const index = at(landmarks, INDEX_MCP);
  const pinky = at(landmarks, PINKY_MCP);
  return (distance(wrist, index, aspect) + distance(wrist, pinky, aspect) + distance(index, pinky, aspect)) / 3;
}

/** Thumb tip to index tip over palm size, so it does not change with distance from the camera. */
export function pinchRatio(landmarks: readonly Landmark[], aspect = 1): number {
  const size = palmSize(landmarks, aspect);
  return size > 0 ? distance(at(landmarks, THUMB_TIP), at(landmarks, INDEX_TIP), aspect) / size : Number.POSITIVE_INFINITY;
}

/** Depth cue 0 (far) .. 1 (near) from apparent palm size. */
export function depthFromPalmSize(size: number): number {
  return clamp01((size - PALM_SIZE_FAR) / (PALM_SIZE_NEAR - PALM_SIZE_FAR));
}

/** Palm centre (mean of wrist, index and pinky knuckles) in image x, y, and depth from palm size. */
export function palmFromLandmarks(landmarks: readonly Landmark[], aspect = 1): Vec3 {
  const points = [at(landmarks, WRIST), at(landmarks, INDEX_MCP), at(landmarks, PINKY_MCP)];
  const x = (points[0]![0] + points[1]![0] + points[2]![0]) / 3;
  const y = (points[0]![1] + points[1]![1] + points[2]![1]) / 3;
  return [x, y, depthFromPalmSize(palmSize(landmarks, aspect))];
}
