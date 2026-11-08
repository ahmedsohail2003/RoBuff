/**
 * How strongly and how fast the arm follows the operator, in one place so it is easy to tune.
 *
 * hand: gripper travel per unit of hand travel in the camera picture, against the first
 *   mapping (HAND_TO_WORLD in handMapping.ts), scaled about the middle of the picture. 1.4
 *   means about 70 percent of the old hand travel spans the same arm range. The target is
 *   still clamped to HAND_WORKSPACE, so a hand near the edge cannot pull the arm out straight.
 * mouse: the same for the pointer over the view, net (the pointer goes through the same
 *   mapping, so mouseSource.ts scales it by mouse / hand). 1.5 is 1.5 times the first mouse map.
 * smootherTimeConstantS: the target smoother's first-order lag (was 0.12 s).
 * imageFilter, depthFilter: One Euro settings for palm x, y (image units) and depth (0..1).
 *   minCutoffHz sets the smoothing of a still hand (unchanged); a higher beta lets a moving
 *   hand through with less lag (image 2.0 -> 3.0). Depth stays at beta 1.0: it comes from
 *   palm size, the noisiest reading, and the gain already scales its jitter by 1.4.
 * Checked by control/responsiveness.test.ts: a still hand with 2.5 px of landmark noise at
 * 640x480 keeps the target jitter to 2.8 mm RMS (depth; under 0.5 mm side to side and up),
 * and a 1 cm hand step reaches 90 percent in 0.38 s instead of 0.48 s.
 */
export const CONTROL_GAINS = {
  hand: 1.4,
  mouse: 1.5,
  smootherTimeConstantS: 0.08,
  imageFilter: { minCutoffHz: 1.0, beta: 3.0, derivativeCutoffHz: 1.0 },
  depthFilter: { minCutoffHz: 0.5, beta: 1.0, derivativeCutoffHz: 1.0 },
} as const;
