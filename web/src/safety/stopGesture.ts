// The stop gesture (M6): both hands open, all fingers extended, held 0.4 s, sets the stop
// latch from M1. If two-hand tracking is too slow (over 120 ms a frame), the fallback is
// one open "stop sign" palm held 0.6 s. Pure logic only: no DOM, no camera, so Node tests
// replay landmark streams through exactly the code the page runs.

import { worldToPalm } from '../control/handMapping';
import type { Landmark } from '../input/handState';
import { palmFromLandmarks, palmSize } from '../input/landmarks';
import { PickScript, type PickPlan } from '../input/pickScript';
import { syntheticLandmarks } from '../input/syntheticHand';
import type { Vec3 } from '../sim/simulation';

export type GestureMode = 'two-hands' | 'one-palm';

/** Hold times from PLAN M6. */
export const TWO_HANDS_HOLD_S = 0.4;
export const ONE_PALM_HOLD_S = 0.6;
/** A pose that drops out for at most this long (a missed frame or two) does not restart the hold. */
export const GAP_TOLERANCE_S = 0.1;
/** Above this median tracking time per frame with two hands, fall back to one palm. */
export const TRACKING_LIMIT_MS = 120;
/** Tracking samples needed before the fallback can be decided. */
export const TRACKING_SAMPLES = 15;

/** Finger chains from knuckle to tip, MediaPipe numbering: index, middle, ring, pinky. */
const FINGERS: ReadonlyArray<readonly [number, number, number, number]> = [
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
];
const THUMB = [2, 3, 4] as const;

/**
 * Thresholds, starting values to check on a real hand. A finger counts as extended when its
 * tip is the farthest of its joints from the wrist and the chain is nearly straight
 * (knuckle-to-tip distance over the summed bone lengths). The thumb counts as out when it is
 * straight, away from the index knuckle, and well apart from the index tip; a relaxed hand
 * with the thumb resting by the index finger (pinch ratio 0.43-0.50 in S3's photo) is not open.
 */
export const OPEN_HAND = {
  fingerStraightness: 0.8,
  thumbStraightness: 0.8,
  /** Thumb tip to index knuckle, in palm sizes. */
  thumbAwayFromIndex: 0.5,
  /** Thumb tip to index tip, in palm sizes (the pinch ratio). */
  thumbIndexGap: 0.6,
  /** Wrist-to-middle-knuckle direction within this many degrees of straight up in the image. */
  maxTiltDeg: 60,
  /** Two hands must have their palm centres at least this many palm sizes apart (not one hand found twice). */
  minHandSeparation: 1.0,
} as const;

/** The one-palm fallback asks for a deliberate stop sign: upright, fingers fanned, thumb out. */
export const STOP_PALM = {
  maxTiltDeg: 35,
  /** Angle between the index and pinky directions. */
  minSpreadDeg: 20,
  /** Angle between the thumb and index directions. */
  minThumbDeg: 30,
} as const;

type P2 = readonly [number, number];

/** Image-plane point with x scaled by the aspect ratio, so x and y are in the same units. */
function p(landmarks: readonly Landmark[], index: number, aspect: number): P2 {
  const point = landmarks[index]!;
  return [point[0] * aspect, point[1]];
}

function dist(a: P2, b: P2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function angleDeg(u: P2, v: P2): number {
  const n = Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1]);
  if (!(n > 0)) return 180;
  const c = Math.min(1, Math.max(-1, (u[0] * v[0] + u[1] * v[1]) / n));
  return (Math.acos(c) * 180) / Math.PI;
}

function dir(a: P2, b: P2): P2 {
  return [b[0] - a[0], b[1] - a[1]];
}

function straightness(points: readonly P2[]): number {
  let path = 0;
  for (let i = 1; i < points.length; i++) path += dist(points[i - 1]!, points[i]!);
  return path > 0 ? dist(points[0]!, points[points.length - 1]!) / path : 0;
}

function finiteHand(landmarks: readonly Landmark[] | undefined): landmarks is Landmark[] {
  return !!landmarks && landmarks.length === 21 && landmarks.every((q) => q.length === 3 && q.every(Number.isFinite));
}

export interface HandShape {
  /** Index, middle, ring, pinky extended. */
  fingers: [boolean, boolean, boolean, boolean];
  thumbOut: boolean;
  /** Degrees between wrist-to-middle-knuckle and straight up in the image. */
  tiltDeg: number;
  spreadDeg: number;
  thumbDeg: number;
  /** Thumb tip to index tip over palm size. */
  thumbIndexGap: number;
  palmSize: number;
}

/** Measures one hand in the image plane. Null if the landmarks are not a hand. */
export function handShape(landmarks: readonly Landmark[], aspect = 1): HandShape | null {
  if (!finiteHand(landmarks)) return null;
  const size = palmSize(landmarks, aspect);
  if (!(size > 0)) return null;
  const wrist = p(landmarks, 0, aspect);
  const fingers = FINGERS.map((chain) => {
    const pts = chain.map((i) => p(landmarks, i, aspect));
    const tip = dist(wrist, pts[3]!);
    return tip > dist(wrist, pts[1]!) && tip > dist(wrist, pts[2]!) && straightness(pts) >= OPEN_HAND.fingerStraightness;
  }) as [boolean, boolean, boolean, boolean];
  const thumb = THUMB.map((i) => p(landmarks, i, aspect));
  const thumbTip = thumb[2]!;
  const indexMcp = p(landmarks, 5, aspect);
  const indexTip = p(landmarks, 8, aspect);
  const thumbIndexGap = dist(thumbTip, indexTip) / size;
  const thumbOut =
    straightness(thumb) >= OPEN_HAND.thumbStraightness &&
    dist(thumbTip, indexMcp) / size >= OPEN_HAND.thumbAwayFromIndex &&
    thumbIndexGap >= OPEN_HAND.thumbIndexGap;
  const tiltDeg = angleDeg(dir(wrist, p(landmarks, 9, aspect)), [0, -1]);
  const spreadDeg = angleDeg(dir(indexMcp, indexTip), dir(p(landmarks, 17, aspect), p(landmarks, 20, aspect)));
  const thumbDeg = angleDeg(dir(thumb[0]!, thumbTip), dir(indexMcp, indexTip));
  return { fingers, thumbOut, tiltDeg, spreadDeg, thumbDeg, thumbIndexGap, palmSize: size };
}

/** All five fingers extended and the hand roughly upright. */
export function isOpenHand(landmarks: readonly Landmark[], aspect = 1): boolean {
  const shape = handShape(landmarks, aspect);
  return !!shape && shape.fingers.every(Boolean) && shape.thumbOut && shape.tiltDeg <= OPEN_HAND.maxTiltDeg;
}

/** The one-palm fallback's pose: an open hand that is upright with the fingers fanned and the thumb out. */
export function isStopPalm(landmarks: readonly Landmark[], aspect = 1): boolean {
  const shape = handShape(landmarks, aspect);
  return (
    !!shape &&
    shape.fingers.every(Boolean) &&
    shape.thumbOut &&
    shape.tiltDeg <= STOP_PALM.maxTiltDeg &&
    shape.spreadDeg >= STOP_PALM.minSpreadDeg &&
    shape.thumbDeg >= STOP_PALM.minThumbDeg
  );
}

/** True when this frame shows the stop pose for the mode. */
export function gesturePosed(hands: readonly (readonly Landmark[])[], mode: GestureMode, aspect = 1): boolean {
  if (mode === 'one-palm') return hands.some((hand) => isStopPalm(hand, aspect));
  const open = hands.filter((hand) => isOpenHand(hand, aspect));
  for (let i = 0; i < open.length; i++) {
    for (let j = i + 1; j < open.length; j++) {
      const a = open[i]!;
      const b = open[j]!;
      const pa = palmFromLandmarks(a, aspect);
      const pb = palmFromLandmarks(b, aspect);
      const apart = Math.hypot((pa[0] - pb[0]) * aspect, pa[1] - pb[1]);
      if (apart >= OPEN_HAND.minHandSeparation * Math.max(palmSize(a, aspect), palmSize(b, aspect))) return true;
    }
  }
  return false;
}

export function holdFor(mode: GestureMode): number {
  return mode === 'two-hands' ? TWO_HANDS_HOLD_S : ONE_PALM_HOLD_S;
}

export interface GestureUpdate {
  posed: boolean;
  /** Seconds the pose has been held without a break longer than GAP_TOLERANCE_S. */
  heldS: number;
  /** True on the one frame where the hold reached its time. */
  fired: boolean;
}

/**
 * Hold timer. It fires once when the pose has been held for the mode's time, then stays
 * quiet until the pose has been released (so a stop cleared by Resume while the hands are
 * still up does not stop again at once). Clearing the stop is never its job.
 */
export class StopGestureDetector {
  private startS: number | null = null;
  private lastPosedS = -Infinity;
  private armed = true;
  frames = 0;
  posedFrames = 0;
  fires = 0;
  maxHeldS = 0;

  constructor(public mode: GestureMode = 'two-hands') {}

  update(hands: readonly (readonly Landmark[])[], tS: number, aspect = 1): GestureUpdate {
    this.frames++;
    const posed = gesturePosed(hands, this.mode, aspect);
    if (posed) {
      this.posedFrames++;
      if (this.startS === null) this.startS = tS;
      this.lastPosedS = tS;
    } else if (this.startS !== null && tS - this.lastPosedS > GAP_TOLERANCE_S) {
      this.startS = null;
      this.armed = true;
    } else if (this.startS === null) {
      this.armed = true;
    }
    const heldS = this.startS === null ? 0 : this.lastPosedS - this.startS;
    this.maxHeldS = Math.max(this.maxHeldS, heldS);
    let fired = false;
    if (posed && this.armed && heldS >= holdFor(this.mode) - 1e-9) {
      fired = true;
      this.armed = false;
      this.fires++;
    }
    return { posed, heldS, fired };
  }

  reset(): void {
    this.startS = null;
    this.lastPosedS = -Infinity;
    this.armed = true;
    this.frames = 0;
    this.posedFrames = 0;
    this.fires = 0;
    this.maxHeldS = 0;
  }
}

function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** True when two-hand tracking is too slow and the one-palm fallback should take over. */
export function shouldFallBack(trackingMs: readonly number[], numHands: number): boolean {
  if (numHands < 2 || trackingMs.length < TRACKING_SAMPLES) return false;
  return (medianOf(trackingMs) ?? 0) > TRACKING_LIMIT_MS;
}

export { medianOf };

// ---- Synthetic streams for the replay tests (no camera, labelled synthetic wherever shown) ----

/** The synthetic right hand mirrored into a left hand about its own palm centre. */
export function mirrorHand(landmarks: readonly Landmark[]): Landmark[] {
  const cx = (landmarks[0]![0] + landmarks[5]![0] + landmarks[17]![0]) / 3;
  return landmarks.map(([x, y, z]) => [2 * cx - x, y, z]);
}

/** Small deterministic wobble, so a replay is not a frozen picture. */
function wobble(landmarks: readonly Landmark[], t: number, amount: number, seed: number): Landmark[] {
  return landmarks.map(([x, y, z], i) => [
    x + amount * Math.sin(17.3 * t + 1.7 * i + seed),
    y + amount * Math.cos(13.1 * t + 2.3 * i + seed),
    z,
  ]);
}

/** Both hands open and raised, swaying slightly: the stop gesture. */
export function twoOpenHandsAt(t: number): Landmark[][] {
  const sway = 0.01 * Math.sin(2 * Math.PI * 0.7 * t);
  const right = syntheticLandmarks([0.68 + sway, 0.5, 0.5], 0);
  const left = mirrorHand(syntheticLandmarks([0.32 + sway, 0.5, 0.5], 0));
  return [wobble(right, t, 0.002, 1), wobble(left, t, 0.002, 2)];
}

/** One open hand, still: not the two-hand gesture. */
export function oneOpenHandAt(t: number): Landmark[][] {
  return [wobble(syntheticLandmarks([0.5, 0.5, 0.5], 0), t, 0.002, 3)];
}

/** How long one pass of the pick script takes, without its endless final dwell. */
export function pickScriptSeconds(plan: PickPlan): number {
  return new PickScript(plan).phases.filter((phase) => phase.name !== 'done').reduce((sum, phase) => sum + phase.moveS + phase.dwellS, 0);
}

/**
 * The S2 pick script's hand, repeated: open approach, pinch, lift, hold, carry, release.
 * The same palm and pinch the synthetic input source draws (syntheticLandmarks over
 * worldToPalm of the scripted gripper target), with a little wobble.
 */
export function pinchCarryStream(plan: PickPlan): (t: number) => Landmark[][] {
  const script = new PickScript(plan);
  const period = pickScriptSeconds(plan);
  return (t) => {
    const sample = script.sample(t % period);
    const palm: Vec3 = worldToPalm(sample.target);
    return [wobble(syntheticLandmarks(palm, sample.grip), t, 0.002, 4)];
  };
}

export type ReplayKind = 'two-open-hands' | 'one-open-hand' | 'pinch-carry';

export function replayStream(kind: ReplayKind, plan: PickPlan): (t: number) => Landmark[][] {
  if (kind === 'two-open-hands') return twoOpenHandsAt;
  if (kind === 'one-open-hand') return oneOpenHandAt;
  return pinchCarryStream(plan);
}

/** Frame rate of the synthetic replays, like a webcam. */
export const REPLAY_FPS = 30;
