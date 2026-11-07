import { describe, expect, it } from 'vitest';
import { handToCommand, palmToWorld } from '../control/handMapping';
import { TargetSmoother, DEFAULT_SMOOTHER } from '../control/targetSmoother';
import type { Vec3 } from '../sim/simulation';
import { HandMapper } from './handMapper';
import type { HandState, Landmark } from './handState';
import { PINCH_CLOSE_BELOW, PINCH_OPEN_ABOVE, palmFromLandmarks, palmSize, pinchRatio } from './landmarks';
import { SYNTHETIC_CLOSED_RATIO, SYNTHETIC_OPEN_RATIO } from './landmarks';
import { syntheticLandmarks } from './syntheticHand';

const FRAME_MS = 33;

/** Pinch amount that makes the synthetic hand draw this ratio. */
function pinchForRatio(ratio: number): number {
  return (SYNTHETIC_OPEN_RATIO - ratio) / (SYNTHETIC_OPEN_RATIO - SYNTHETIC_CLOSED_RATIO);
}

function hand(palm: Vec3, pinch: number): { landmarks: Landmark[]; score: number } {
  return { landmarks: syntheticLandmarks(palm, pinch), score: 0.95 };
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

describe('landmark geometry', () => {
  it('reads palm centre and depth back from synthetic landmarks', () => {
    const palm: Vec3 = [0.31, 0.64, 0.42];
    palmFromLandmarks(syntheticLandmarks(palm, 0)).forEach((value, i) => expect(value).toBeCloseTo(palm[i]!, 9));
  });

  it('gives a pinch ratio that does not change with hand size (distance from camera)', () => {
    const far = pinchRatio(syntheticLandmarks([0.5, 0.5, 0.1], 0.4));
    const near = pinchRatio(syntheticLandmarks([0.5, 0.5, 0.9], 0.4));
    expect(near).toBeCloseTo(far, 9);
  });

  it('scales x and z by the image aspect ratio', () => {
    const square = syntheticLandmarks([0.5, 0.5, 0.5], 0);
    // The same hand seen in a 4:3 image is squeezed in normalized x.
    const wide = square.map(([x, y, z]) => [0.5 + (x - 0.5) * 0.75, y, z * 0.75] as Landmark);
    expect(palmSize(wide, 4 / 3)).toBeCloseTo(palmSize(square), 9);
  });
});

describe('hand to arm mapping', () => {
  it('moves the target the way the hand moves', () => {
    const centre = palmToWorld([0.5, 0.5, 0.5]);
    expect(palmToWorld([0.3, 0.5, 0.5])[0]).toBeGreaterThan(centre[0]); // raw image left = user's right = +x
    expect(palmToWorld([0.5, 0.3, 0.5])[2]).toBeGreaterThan(centre[2]); // hand higher = gripper higher
    expect(palmToWorld([0.5, 0.5, 0.8])[1]).toBeLessThan(centre[1]); // bigger hand (nearer) = reach farther (-y)
  });

  it('settles on the hand position through the filter', () => {
    const mapper = new HandMapper();
    const palm: Vec3 = [0.4, 0.55, 0.5];
    let state: HandState | null = null;
    for (let i = 0; i < 90; i++) state = mapper.update(hand(palm, 0), i * FRAME_MS);
    state!.palm.forEach((value, i) => expect(value).toBeCloseTo(palm[i]!, 6));
    expect(state!.confidence).toBeCloseTo(0.95, 9);
    expect(handToCommand(state!)!.target).toEqual(palmToWorld(state!.palm));
  });

  it('smooths a jittery still hand to under half the raw jitter in world space', () => {
    const mapper = new HandMapper();
    let seed = 12345;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
    const raw: Vec3[] = [];
    const out: Vec3[] = [];
    for (let i = 0; i < 300; i++) {
      const palm: Vec3 = [0.5 + 0.004 * random(), 0.5 + 0.004 * random(), 0.5 + 0.03 * random()];
      const state = mapper.update(hand(palm, 0), i * FRAME_MS)!;
      if (i >= 60) {
        raw.push(palmToWorld(palmFromLandmarks(syntheticLandmarks(palm, 0))));
        out.push(palmToWorld(state.palm));
      }
    }
    const spread = (points: Vec3[]) => {
      const mean = [0, 1, 2].map((k) => points.reduce((a, p) => a + p[k]!, 0) / points.length) as Vec3;
      return Math.sqrt(points.reduce((a, p) => a + distance(p, mean) ** 2, 0) / points.length);
    };
    console.log(`MAPPER_WORLD_JITTER raw ${(spread(raw) * 1000).toFixed(2)} mm filtered ${(spread(out) * 1000).toFixed(2)} mm`);
    expect(spread(out)).toBeLessThan(spread(raw) / 2);
  });

  it('closes the grip on a pinch and opens it on release, through the landmarks', () => {
    const mapper = new HandMapper();
    const palm: Vec3 = [0.5, 0.5, 0.5];
    const run = (pinch: number, frames: number, t0: number) => {
      let state: HandState | null = null;
      for (let i = 0; i < frames; i++) state = mapper.update(hand(palm, pinch), t0 + i * FRAME_MS);
      return state!;
    };
    expect(run(0, 5, 0).pinch).toBe(0);
    expect(run(1, 5, 1000).pinch).toBe(1);
    expect(run(pinchForRatio((PINCH_CLOSE_BELOW + PINCH_OPEN_ABOVE) / 2), 20, 2000).pinch).toBe(1); // between: stays closed
    expect(run(0, 5, 3000).pinch).toBe(0);
  });

  it('does not flap the gripper when a noisy pinch sits on the close threshold', () => {
    const mapper = new HandMapper();
    const palm: Vec3 = [0.5, 0.5, 0.5];
    let flips = 0;
    let previous: number | null = null;
    for (let i = 0; i < 600; i++) {
      const ratio = PINCH_CLOSE_BELOW + 0.05 * Math.sin(i * 2.1) + 0.03 * Math.sin(i * 0.23);
      const state = mapper.update(hand(palm, pinchForRatio(ratio)), i * FRAME_MS)!;
      if (previous !== null && state.pinch !== previous) flips++;
      previous = state.pinch;
    }
    expect(flips).toBeLessThanOrEqual(1);
  });

  it('holds the last target and grip with confidence 0 while the hand is lost', () => {
    const mapper = new HandMapper();
    const palm: Vec3 = [0.35, 0.45, 0.6];
    let last: HandState | null = null;
    for (let i = 0; i < 60; i++) last = mapper.update(hand(palm, 1), i * FRAME_MS);
    expect(last!.pinch).toBe(1);
    for (let i = 60; i < 120; i++) {
      const lost = mapper.update(null, i * FRAME_MS)!;
      expect(lost.confidence).toBe(0);
      expect(lost.palm).toEqual(last!.palm);
      expect(lost.pinch).toBe(1); // a held object is not dropped when tracking drops out
      expect(handToCommand(lost)).toBeNull();
    }
  });

  it('when the hand returns somewhere else, waits for it to be confirmed and restarts the filter there', () => {
    const mapper = new HandMapper();
    const before: Vec3 = [0.3, 0.4, 0.5];
    const after: Vec3 = [0.7, 0.6, 0.3];
    let t = 0;
    for (let i = 0; i < 60; i++, t += FRAME_MS) mapper.update(hand(before, 0), t);
    const held = mapper.update(null, (t += FRAME_MS))!.palm;
    for (let i = 0; i < 10; i++, t += FRAME_MS) mapper.update(null, t);

    const first = mapper.update(hand(after, 0), (t += FRAME_MS))!;
    expect(first.confidence).toBe(0); // one frame does not count yet
    expect(first.palm).toEqual(held);
    const second = mapper.update(hand(after, 0), (t += FRAME_MS))!;
    expect(second.confidence).toBeGreaterThan(0.5);
    // Restarted at the new position: no blend with the stale position and no overshoot.
    second.palm.forEach((value, i) => expect(Math.abs(value - after[i]!)).toBeLessThan(0.01));
  });

  it('the arm target never jumps when the hand comes back: the smoother caps its speed', () => {
    const mapper = new HandMapper();
    const smoother = new TargetSmoother();
    const dt = 0.01;
    let goal: Vec3 | null = null;
    let previous: Vec3 | null = null;
    let maxStep = 0;
    for (let i = 0; i < 400; i++) {
      const tMs = i * 10;
      const visible = i < 100 || i >= 200;
      const palm: Vec3 = i < 100 ? [0.3, 0.4, 0.5] : [0.7, 0.7, 0.2];
      const state = mapper.update(visible ? hand(palm, 0) : null, tMs);
      const command = state ? handToCommand(state) : null;
      if (command) goal = command.target;
      if (!goal) continue;
      const next = smoother.step(goal, dt);
      if (previous) maxStep = Math.max(maxStep, distance(next, previous));
      previous = next;
    }
    expect(maxStep).toBeLessThanOrEqual(DEFAULT_SMOOTHER.maxSpeed * dt + 1e-12);
  });

  it('returns null before any hand has been seen, and ignores a malformed hand', () => {
    const mapper = new HandMapper();
    expect(mapper.update(null, 0)).toBeNull();
    expect(mapper.update({ landmarks: syntheticLandmarks([0.5, 0.5, 0.5], 0).slice(0, 20), score: 1 }, 33)).toBeNull();
    const broken = syntheticLandmarks([0.5, 0.5, 0.5], 0);
    broken[3] = [Number.NaN, 0, 0];
    expect(mapper.update({ landmarks: broken, score: 1 }, 66)).toBeNull();
  });
});
