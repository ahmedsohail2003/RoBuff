import { describe, expect, it } from 'vitest';
import type { Landmark } from '../input/handState';
import type { PickPlan } from '../input/pickScript';
import { syntheticLandmarks } from '../input/syntheticHand';
import {
  gesturePosed,
  handShape,
  isOpenHand,
  isStopPalm,
  mirrorHand,
  oneOpenHandAt,
  pickScriptSeconds,
  pinchCarryStream,
  REPLAY_FPS,
  shouldFallBack,
  StopGestureDetector,
  twoOpenHandsAt,
  type GestureMode,
} from './stopGesture';

/** The S2 cube plan's numbers (cube at (0, -0.22), 30 mm), so the replay is the browser's pick. */
const PLAN: PickPlan = { objectCenter: [0, -0.22, 0.015], objectHalfWidth: 0.015, start: [0, -0.2, 0.15] };

/** Runs a stream through a detector at REPLAY_FPS; returns the replay time of the first fire, or null. */
function run(stream: (t: number) => Landmark[][], seconds: number, mode: GestureMode = 'two-hands') {
  const detector = new StopGestureDetector(mode);
  let firstFire: number | null = null;
  for (let k = 0; k <= seconds * REPLAY_FPS; k++) {
    const t = k / REPLAY_FPS;
    if (detector.update(stream(t), t).fired) firstFire ??= t;
  }
  return { firstFire, fires: detector.fires, posedFrames: detector.posedFrames, frames: detector.frames, maxHeldS: detector.maxHeldS };
}

/** Turns each finger chain about its knuckle (degrees, + is clockwise on screen) to fan the fingers. */
function fanned(landmarks: Landmark[], degrees: [number, number, number, number, number]): Landmark[] {
  const out = landmarks.map((q) => [...q] as Landmark);
  const chains = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
  chains.forEach((chain, f) => {
    const a = (degrees[f]! * Math.PI) / 180;
    const [cx, cy] = landmarks[chain[0]!]!;
    for (const i of chain.slice(1)) {
      const [x, y, z] = landmarks[i]!;
      const dx = x - cx;
      const dy = y - cy;
      out[i] = [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a), z];
    }
  });
  return out;
}

const OPEN = syntheticLandmarks([0.5, 0.5, 0.5], 0);
const PINCHED = syntheticLandmarks([0.5, 0.5, 0.5], 1);
const STOP_SIGN = fanned(OPEN, [-25, -12, -4, 4, 14]);

/** A fist: every finger tip folded back to between its knuckle and the wrist. */
function fist(): Landmark[] {
  const out = OPEN.map((q) => [...q] as Landmark);
  const w = OPEN[0]!;
  for (const [mcp, tip] of [[5, 8], [9, 12], [13, 16], [17, 20], [2, 4]] as const) {
    const m = OPEN[mcp]!;
    out[tip] = [(m[0] + w[0]) / 2, (m[1] + w[1]) / 2, 0];
    out[tip - 1] = [m[0], m[1] - 0.01, 0];
  }
  return out;
}

describe('hand shape', () => {
  it('the synthetic open hand has every finger out; the pinched hand does not', () => {
    const open = handShape(OPEN)!;
    expect(open.fingers).toEqual([true, true, true, true]);
    expect(open.thumbOut).toBe(true);
    expect(open.tiltDeg).toBeLessThan(10);
    expect(isOpenHand(OPEN)).toBe(true);
    const pinched = handShape(PINCHED)!;
    expect(pinched.fingers[0]).toBe(false);
    expect(pinched.thumbOut).toBe(false);
    expect(isOpenHand(PINCHED)).toBe(false);
  });

  it('a half pinch, a fist, a hand on its side and garbage are not open', () => {
    expect(isOpenHand(syntheticLandmarks([0.5, 0.5, 0.5], 0.5))).toBe(false);
    expect(isOpenHand(fist())).toBe(false);
    const sideways = OPEN.map(([x, y, z]) => [0.5 + (y - 0.5), 0.5 - (x - 0.5), z] as Landmark);
    expect(handShape(sideways)!.tiltDeg).toBeGreaterThan(80);
    expect(isOpenHand(sideways)).toBe(false);
    expect(isOpenHand(OPEN.slice(0, 20))).toBe(false);
    expect(isOpenHand(OPEN.map(() => [Number.NaN, 0, 0] as Landmark))).toBe(false);
  });

  it('a relaxed open hand with the thumb by the index finger (pinch ratio 0.45, like S3 photo hands) is not open', () => {
    // pinch amount that draws a ratio of 0.45: 1 - p * 0.85 = 0.45
    const relaxed = syntheticLandmarks([0.5, 0.5, 0.5], 0.55 / 0.85);
    expect(handShape(relaxed)!.thumbIndexGap).toBeCloseTo(0.45, 2);
    expect(isOpenHand(relaxed)).toBe(false);
  });

  it('the thumb must be well apart from the index tip: 0.45 palm sizes is not open, 0.7 is', () => {
    const size = handShape(OPEN)!.palmSize;
    const withThumbGap = (gap: number) => {
      const hand = OPEN.map((q) => [...q] as Landmark);
      hand[4] = [OPEN[8]![0] - gap * size, OPEN[8]![1], 0];
      return hand;
    };
    expect(handShape(withThumbGap(0.45))!.thumbIndexGap).toBeCloseTo(0.45, 6);
    expect(handShape(withThumbGap(0.45))!.fingers).toEqual([true, true, true, true]);
    expect(isOpenHand(withThumbGap(0.45))).toBe(false);
    expect(isOpenHand(withThumbGap(0.7))).toBe(true);
  });

  it('a finger hooked sideways at its middle joint is not extended, though its tip is farthest out', () => {
    const hand = OPEN.map((q) => [...q] as Landmark);
    const d = (a: number, b: number) => Math.hypot(OPEN[a]![0] - OPEN[b]![0], OPEN[a]![1] - OPEN[b]![1]);
    const [x6, y6] = OPEN[6]!;
    hand[7] = [x6 - d(6, 7), y6, 0];
    hand[8] = [x6 - d(6, 7) - d(7, 8), y6, 0];
    const shape = handShape(hand)!;
    expect(shape.fingers).toEqual([false, true, true, true]);
    expect(isOpenHand(hand)).toBe(false);
  });

  it('the one-palm fallback wants a fanned stop sign, not just an open hand', () => {
    expect(isOpenHand(STOP_SIGN)).toBe(true);
    expect(handShape(OPEN)!.spreadDeg).toBeLessThan(20);
    expect(isStopPalm(OPEN)).toBe(false);
    expect(handShape(STOP_SIGN)!.spreadDeg).toBeGreaterThanOrEqual(20);
    expect(isStopPalm(STOP_SIGN)).toBe(true);
    expect(isStopPalm(PINCHED)).toBe(false);
  });

  it('two hands pose the gesture only when both are open and apart', () => {
    const right = syntheticLandmarks([0.68, 0.5, 0.5], 0);
    const left = mirrorHand(syntheticLandmarks([0.32, 0.5, 0.5], 0));
    expect(isOpenHand(left)).toBe(true);
    expect(gesturePosed([right, left], 'two-hands')).toBe(true);
    expect(gesturePosed([right], 'two-hands')).toBe(false);
    expect(gesturePosed([right, syntheticLandmarks([0.32, 0.5, 0.5], 1)], 'two-hands')).toBe(false);
    // The same hand reported twice (palms 0.01 apart) is one hand.
    expect(gesturePosed([right, syntheticLandmarks([0.69, 0.5, 0.5], 0)], 'two-hands')).toBe(false);
  });
});

describe('stop gesture detector', () => {
  it('two open hands latch after 0.4 s, inside 0.5 s, and fire once while held', () => {
    const result = run(twoOpenHandsAt, 3);
    expect(result.firstFire).not.toBeNull();
    expect(result.firstFire!).toBeGreaterThanOrEqual(0.4 - 1e-9);
    expect(result.firstFire!).toBeLessThan(0.5);
    expect(result.fires).toBe(1);
  });

  it('a 20 s pinch-and-carry replay of the S2 pick never fires, in either mode', () => {
    expect(pickScriptSeconds(PLAN)).toBeCloseTo(14.8, 6);
    const stream = pinchCarryStream(PLAN);
    const frames = stream(0);
    expect(frames).toHaveLength(1);
    const two = run(stream, 20, 'two-hands');
    expect(two.frames).toBe(20 * REPLAY_FPS + 1);
    expect(two.fires).toBe(0);
    expect(two.posedFrames).toBe(0);
    const one = run(stream, 20, 'one-palm');
    expect(one.fires).toBe(0);
    // The approach and release phases do show an open hand; only the pinch phases are not open.
    let open = 0;
    let pinched = 0;
    for (let k = 0; k <= 20 * REPLAY_FPS; k++) {
      const hand = stream(k / REPLAY_FPS)[0]!;
      if (isOpenHand(hand)) open++;
      if (!isOpenHand(hand)) pinched++;
    }
    expect(open).toBeGreaterThan(0);
    expect(pinched).toBeGreaterThan(0);
  });

  it('one open hand never fires the two-hand gesture', () => {
    expect(run(oneOpenHandAt, 10).fires).toBe(0);
  });

  it('a pose broken for longer than 0.1 s restarts the hold; a one-frame dropout does not', () => {
    // Open for 0.3 s, gone for 0.2 s, open for 0.3 s: never 0.4 s unbroken.
    const broken = (t: number) => (t % 0.5 < 0.3 ? twoOpenHandsAt(t) : []);
    expect(run(broken, 5).fires).toBe(0);
    // One missing frame every 0.2 s (a tracker dropout) still completes the hold.
    const dropouts = (t: number) => (Math.round(t * REPLAY_FPS) % 6 === 5 ? [] : twoOpenHandsAt(t));
    const result = run(dropouts, 2);
    expect(result.firstFire).not.toBeNull();
    expect(result.firstFire!).toBeLessThan(0.5);
  });

  it('after firing it waits for the hands to come down before it can fire again', () => {
    const upDownUp = (t: number) => (t < 1 || t >= 1.5 ? twoOpenHandsAt(t) : []);
    const result = run(upDownUp, 3);
    expect(result.fires).toBe(2);
  });

  it('the one-palm fallback holds 0.6 s', () => {
    const result = run(() => [STOP_SIGN], 2, 'one-palm');
    expect(result.firstFire!).toBeGreaterThanOrEqual(0.6 - 1e-9);
    expect(result.firstFire!).toBeLessThan(0.7);
  });
});

describe('fallback to one palm', () => {
  it('falls back only with two hands, enough samples, and a median over 120 ms', () => {
    const slow = Array.from({ length: 15 }, () => 130);
    expect(shouldFallBack(slow, 2)).toBe(true);
    expect(shouldFallBack(slow, 1)).toBe(false);
    expect(shouldFallBack(slow.slice(0, 14), 2)).toBe(false);
    expect(shouldFallBack(Array.from({ length: 15 }, () => 120), 2)).toBe(false);
    // One slow first frame among fast ones does not trip it.
    expect(shouldFallBack([900, ...Array.from({ length: 20 }, () => 30)], 2)).toBe(false);
  });
});
