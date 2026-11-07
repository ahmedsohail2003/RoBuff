import type { HandState, Landmark } from './handState';
import { isHand, palmFromLandmarks, pinchRatio } from './landmarks';
import { OneEuroFilter3, type OneEuroOptions } from './oneEuro';
import { PinchLatch, type PinchLatchOptions, DEFAULT_PINCH_LATCH } from './pinchLatch';

/** What a hand tracker (or the synthetic hand) reports for one frame. */
export interface RawHand {
  landmarks: Landmark[];
  /** The tracker's confidence that this is a hand, 0..1. */
  score: number;
}

export interface HandMapperOptions {
  /** One Euro settings for palm x, y (image units) and depth (0..1). Starting values, to tune on a real hand. */
  filter: readonly [OneEuroOptions, OneEuroOptions, OneEuroOptions];
  pinch: PinchLatchOptions;
  /** After the hand is lost, frames it must be seen again before the arm follows it. */
  reacquireFrames: number;
}

const IMAGE_AXIS: OneEuroOptions = { minCutoffHz: 1.0, beta: 2.0, derivativeCutoffHz: 1.0 };
const DEPTH_AXIS: OneEuroOptions = { minCutoffHz: 0.5, beta: 1.0, derivativeCutoffHz: 1.0 };

export const DEFAULT_HAND_MAPPER: HandMapperOptions = {
  filter: [IMAGE_AXIS, IMAGE_AXIS, DEPTH_AXIS],
  pinch: DEFAULT_PINCH_LATCH,
  reacquireFrames: 2,
};

export interface HandMapperStats {
  frames: number;
  framesWithHand: number;
  lostFrames: number;
  lastPinchRatio: number | null;
  pinchClosed: boolean;
  /** True while a returning hand is being confirmed. */
  reacquiring: boolean;
}

/**
 * The one mapping from raw landmarks to HandState, shared by the webcam and the synthetic
 * hand: palm position from landmarks 0, 5 and 17 with a One Euro filter, depth from palm
 * size, and pinch through a hysteresis latch. When the hand is lost it reports the last
 * palm and pinch with confidence 0, so the arm holds where it was; when the hand comes
 * back the filter restarts at the new position instead of blending from stale motion.
 */
export class HandMapper {
  private readonly filter: OneEuroFilter3;
  private readonly latch: PinchLatch;
  private last: { palm: [number, number, number]; pinch: number } | null = null;
  private seenStreak = 0;
  private lost = true;
  private counts = { frames: 0, framesWithHand: 0, lostFrames: 0 };
  private lastRatio: number | null = null;

  constructor(readonly options: HandMapperOptions = DEFAULT_HAND_MAPPER) {
    this.filter = new OneEuroFilter3(options.filter);
    this.latch = new PinchLatch(options.pinch);
  }

  /**
   * One frame. hand is null when the tracker found no hand. aspect is image width over
   * height, so distances in x and y are comparable. Returns null until a hand has been seen.
   */
  update(hand: RawHand | null, tMs: number, aspect = 1): HandState | null {
    this.counts.frames++;
    if (!hand || !isHand(hand.landmarks) || !(hand.score > 0)) {
      this.counts.lostFrames++;
      this.lost = true;
      this.seenStreak = 0;
      return this.last ? { palm: [...this.last.palm], pinch: this.last.pinch, confidence: 0, tMs } : null;
    }

    this.counts.framesWithHand++;
    if (this.lost) {
      this.filter.reset();
      this.lost = false;
    }
    this.seenStreak++;
    const palm = this.filter.filter(palmFromLandmarks(hand.landmarks, aspect), tMs / 1000);
    const ratio = pinchRatio(hand.landmarks, aspect);
    this.lastRatio = ratio;
    const pinch = this.latch.update(ratio) ? 1 : 0;
    const confirmed = this.seenStreak >= this.options.reacquireFrames;
    if (confirmed || !this.last) this.last = { palm, pinch };
    return {
      landmarks: hand.landmarks,
      palm: [...this.last.palm],
      pinch: this.last.pinch,
      pinchRatio: ratio,
      confidence: confirmed ? Math.min(1, hand.score) : 0,
      tMs,
    };
  }

  reset(): void {
    this.filter.reset();
    this.latch.reset();
    this.last = null;
    this.seenStreak = 0;
    this.lost = true;
    this.lastRatio = null;
    this.counts = { frames: 0, framesWithHand: 0, lostFrames: 0 };
  }

  stats(): HandMapperStats {
    return {
      ...this.counts,
      lastPinchRatio: this.lastRatio,
      pinchClosed: this.latch.closed,
      reacquiring: !this.lost && this.seenStreak < this.options.reacquireFrames,
    };
  }
}
