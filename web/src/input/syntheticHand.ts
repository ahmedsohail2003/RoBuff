import type { Vec3 } from '../sim/simulation';
import type { Landmark } from './handState';
import { PALM_SIZE_FAR, PALM_SIZE_NEAR, SYNTHETIC_CLOSED_RATIO, SYNTHETIC_OPEN_RATIO, palmSize } from './landmarks';

/**
 * A flat, upright right hand in hand units (x right, y down in the image), with the palm
 * centre (mean of landmarks 0, 5, 17) at the origin. Thumb and index tips are placed by
 * the pinch amount. Index = MediaPipe landmark number.
 */
const BASE_LAYOUT: ReadonlyArray<readonly [number, number]> = [
  [0, 0.5], // 0 wrist
  [-0.3, 0.3], [-0.45, 0.15], [-0.55, 0], [0, 0], // 1-4 thumb; tip placed below
  [-0.3, -0.25], [-0.33, -0.5], [-0.36, -0.68], [0, 0], // 5-8 index; tip placed below
  [-0.1, -0.3], [-0.1, -0.55], [-0.1, -0.75], [-0.1, -0.92], // 9-12 middle
  [0.1, -0.28], [0.1, -0.51], [0.1, -0.69], [0.1, -0.85], // 13-16 ring
  [0.3, -0.25], [0.32, -0.43], [0.34, -0.57], [0.36, -0.7], // 17-20 pinky
];
const BASE_PALM_SIZE = palmSize(BASE_LAYOUT.map(([x, y]) => [x, y, 0] as Landmark));
const PINCH_POINT: readonly [number, number] = [-0.55, -0.45];
const PINCH_AXIS: readonly [number, number] = [0.6, -0.8];

/**
 * 21 landmarks for a hand whose palm reads back as `palm` (image x, y and depth 0..1) and
 * whose pinch amount (0 open .. 1 pinched) sets the thumb-to-index gap. They are read by
 * the same mapping code the webcam uses, so a test with this hand exercises that code.
 */
export function syntheticLandmarks(palm: Vec3, pinch: number): Landmark[] {
  const depth = Math.min(1, Math.max(0, palm[2]));
  const size = PALM_SIZE_FAR + depth * (PALM_SIZE_NEAR - PALM_SIZE_FAR);
  const scale = size / BASE_PALM_SIZE;
  const halfGap = (syntheticPinchRatio(pinch) * BASE_PALM_SIZE) / 2;

  const layout = BASE_LAYOUT.map(([x, y]) => [x, y] as [number, number]);
  layout[8] = [PINCH_POINT[0] + PINCH_AXIS[0] * halfGap, PINCH_POINT[1] + PINCH_AXIS[1] * halfGap];
  layout[4] = [PINCH_POINT[0] - PINCH_AXIS[0] * halfGap, PINCH_POINT[1] - PINCH_AXIS[1] * halfGap];
  return layout.map(([x, y]) => [palm[0] + scale * x, palm[1] + scale * y, 0]);
}

/** The pinch ratio syntheticLandmarks draws for a pinch amount. */
export function syntheticPinchRatio(pinch: number): number {
  return SYNTHETIC_OPEN_RATIO - Math.min(1, Math.max(0, pinch)) * (SYNTHETIC_OPEN_RATIO - SYNTHETIC_CLOSED_RATIO);
}
