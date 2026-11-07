import { PINCH_CLOSE_BELOW, PINCH_OPEN_ABOVE } from './landmarks';

export interface PinchLatchOptions {
  closeBelow: number;
  openAbove: number;
  /** Consecutive frames past a threshold before the state changes, so one bad frame cannot flip it. */
  confirmFrames: number;
}

export const DEFAULT_PINCH_LATCH: PinchLatchOptions = {
  closeBelow: PINCH_CLOSE_BELOW,
  openAbove: PINCH_OPEN_ABOVE,
  confirmFrames: 2,
};

/**
 * Turns a noisy pinch ratio into a steady open / closed state. It closes only after the
 * ratio stays below closeBelow for confirmFrames frames, and opens only after it stays
 * above openAbove as long. Between the two thresholds it keeps its state, so a ratio
 * hovering at either threshold cannot make the gripper flap.
 */
export class PinchLatch {
  private closedState = false;
  private streak = 0;

  constructor(readonly options: PinchLatchOptions = DEFAULT_PINCH_LATCH) {
    if (!(options.closeBelow < options.openAbove)) throw new Error('closeBelow must be below openAbove');
  }

  get closed(): boolean {
    return this.closedState;
  }

  reset(): void {
    this.closedState = false;
    this.streak = 0;
  }

  update(ratio: number): boolean {
    const o = this.options;
    const wantsChange = this.closedState ? ratio > o.openAbove : ratio < o.closeBelow;
    this.streak = wantsChange ? this.streak + 1 : 0;
    if (this.streak >= o.confirmFrames) {
      this.closedState = !this.closedState;
      this.streak = 0;
    }
    return this.closedState;
  }
}
