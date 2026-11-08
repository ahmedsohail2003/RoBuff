import { describe, expect, it } from 'vitest';
import { DEFAULT_HAND_MAPPER, HandMapper, type HandMapperOptions } from '../input/handMapper';
import type { Landmark } from '../input/handState';
import { syntheticLandmarks } from '../input/syntheticHand';
import type { Vec3 } from '../sim/simulation';
import { CONTROL_GAINS } from './gains';
import { handToCommand, HAND_TO_WORLD } from './handMapping';
import { DEFAULT_SMOOTHER, TargetSmoother } from './targetSmoother';

const CAMERA_FPS = 30;
const CONTROL_DT = 0.01;
/** About 2.5 px of landmark noise on a 640 x 480 picture, in image units. */
const NOISE = { x: 2.5 / 640, y: 2.5 / 480 };

interface Tuning {
  filter: HandMapperOptions['filter'];
  timeConstantS: number;
  gain: number;
}

/** The settings before this retune: One Euro beta 2.0 (x, y) and 1.0 (depth), smoother 0.12 s, gain 1. */
const BEFORE: Tuning = {
  filter: [
    { minCutoffHz: 1.0, beta: 2.0, derivativeCutoffHz: 1.0 },
    { minCutoffHz: 1.0, beta: 2.0, derivativeCutoffHz: 1.0 },
    { minCutoffHz: 0.5, beta: 1.0, derivativeCutoffHz: 1.0 },
  ],
  timeConstantS: 0.12,
  gain: 1,
};
const NOW: Tuning = { filter: DEFAULT_HAND_MAPPER.filter, timeConstantS: DEFAULT_SMOOTHER.timeConstantS, gain: CONTROL_GAINS.hand };

/** Seeded normal noise (Box-Muller on a small LCG), so the test is the same every run. */
function gaussian(seed: number): () => number {
  let state = seed;
  const uniform = () => ((state = (state * 1103515245 + 12345) % 2147483648) + 1) / 2147483649;
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

/** The arm target x for a filtered palm under a tuning: palmToWorld's x, with that tuning's gain. */
const worldX = (palmX: number, gain: number) => HAND_TO_WORLD.xCenter + (0.5 - palmX) * HAND_TO_WORLD.xSpan * gain;

/** palmToWorld's algebra with a given gain, so the old tuning can be run next to the new one. */
function worldOf(palm: Vec3, gain: number): Vec3 {
  const m = HAND_TO_WORLD;
  const midY = m.yNear - 0.5 * m.ySpan;
  const midZ = m.zLow + 0.5 * m.zSpan;
  return [worldX(palm[0], gain), midY - (palm[2] - 0.5) * m.ySpan * gain, midZ + (0.5 - palm[1]) * m.zSpan * gain];
}

/** RMS per axis and worst distance from the mean, in mm, after the first 2 s. */
function jitter(samples: { t: number; target: Vec3 }[]): { rmsMm: number[]; worstMm: number } {
  const kept = samples.filter((s) => s.t >= 2);
  const mean = [0, 1, 2].map((k) => kept.reduce((a, s) => a + s.target[k]!, 0) / kept.length);
  const rmsMm = [0, 1, 2].map((k) => 1000 * Math.sqrt(kept.reduce((a, s) => a + (s.target[k]! - mean[k]!) ** 2, 0) / kept.length));
  const worstMm = 1000 * Math.max(...kept.map((s) => Math.hypot(...s.target.map((v, k) => v - mean[k]!))));
  return { rmsMm, worstMm };
}

/**
 * Camera frames at 30 fps through the hand mapper, and the target smoother at the control
 * rate, as in the app. Returns the smoothed target at every control step.
 */
function run(tuning: Tuning, palmAt: (t: number) => Vec3, seconds: number, noise: (() => number) | null, useCommand: boolean): { t: number; target: Vec3 }[] {
  const mapper = new HandMapper({ ...DEFAULT_HAND_MAPPER, filter: tuning.filter });
  const smoother = new TargetSmoother({ ...DEFAULT_SMOOTHER, timeConstantS: tuning.timeConstantS });
  const out: { t: number; target: Vec3 }[] = [];
  let goal: Vec3 | null = null;
  let nextFrame = 0;
  for (let step = 0; step * CONTROL_DT <= seconds; step++) {
    const t = step * CONTROL_DT;
    if (t >= nextFrame - 1e-9) {
      nextFrame += 1 / CAMERA_FPS;
      let landmarks: Landmark[] = syntheticLandmarks(palmAt(t), 0);
      if (noise) landmarks = landmarks.map(([x, y, z]) => [x + NOISE.x * noise(), y + NOISE.y * noise(), z]);
      const state = mapper.update({ landmarks, score: 0.95 }, t * 1000);
      if (state && state.confidence >= 0.5) {
        if (useCommand) goal = handToCommand(state)?.target ?? goal;
        else goal = worldOf(state.palm, tuning.gain);
      }
    }
    if (goal) out.push({ t, target: smoother.step(goal, CONTROL_DT) });
  }
  return out;
}

/** Seconds from the step until the target covers 90 percent of it. */
function riseTime90(tuning: Tuning): number {
  const stepAt = 1;
  const before = 0.5;
  const after = 0.52;
  const samples = run(tuning, (t) => [t < stepAt ? before : after, 0.5, 0.45], 3, null, false);
  const start = worldX(before, tuning.gain);
  const end = worldX(after, tuning.gain);
  const reached = samples.find((s) => s.t >= stepAt && (s.target[0] - start) / (end - start) >= 0.9);
  if (!reached) throw new Error('never reached 90 percent');
  return reached.t - stepAt;
}

describe('responsiveness retune (control/gains.ts)', () => {
  it('keeps a still hand with 2.5 px of landmark noise to a few mm of target jitter', () => {
    const { rmsMm, worstMm } = jitter(run(NOW, () => [0.5, 0.5, 0.45], 12, gaussian(20261107), true));
    const was = jitter(run(BEFORE, () => [0.5, 0.5, 0.45], 12, gaussian(20261107), false));
    console.log(`STILL_HAND_JITTER now rms_mm=${rmsMm.map((v) => v.toFixed(2)).join(',')} worst_mm=${worstMm.toFixed(2)}; before rms_mm=${was.rmsMm.map((v) => v.toFixed(2)).join(',')} worst_mm=${was.worstMm.toFixed(2)}`);
    for (const value of rmsMm) expect(value).toBeLessThan(3);
    expect(worstMm).toBeLessThan(8);
  });

  it('reaches 90 percent of a step faster than before', () => {
    const was = riseTime90(BEFORE);
    const now = riseTime90(NOW);
    console.log(`STEP_90 before_s=${was.toFixed(3)} now_s=${now.toFixed(3)}`);
    expect(now).toBeLessThan(was * 0.85);
  });

  it('spans the same arm range with about 70 percent of the hand travel', () => {
    const oldSpan = worldX(0, 1) - worldX(1, 1);
    const handTravel = oldSpan / (HAND_TO_WORLD.xSpan * CONTROL_GAINS.hand);
    expect(handTravel).toBeGreaterThan(0.68);
    expect(handTravel).toBeLessThan(0.75);
  });
});
