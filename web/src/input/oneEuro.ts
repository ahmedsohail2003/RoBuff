/**
 * One Euro filter (Casiez, Roussel and Vogel, CHI 2012): a low-pass filter whose cutoff
 * rises with speed. Slow hands get heavy smoothing (no jitter); fast hands get little
 * (low lag). Written for this project from the published equations.
 */
export interface OneEuroOptions {
  /** Cutoff in Hz when the hand is still. Lower is smoother and laggier. */
  minCutoffHz: number;
  /** How much the cutoff rises per unit/s of speed. Higher means less lag on fast moves. */
  beta: number;
  /** Cutoff in Hz for the speed estimate itself. */
  derivativeCutoffHz: number;
}

/** alpha for a first-order low-pass with this cutoff, sampled every dt seconds. */
function smoothingFactor(cutoffHz: number, dtS: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtS);
}

export class OneEuroFilter {
  private value: number | null = null;
  private speed = 0;
  private lastS = 0;

  constructor(readonly options: OneEuroOptions) {}

  get current(): number | null {
    return this.value;
  }

  reset(): void {
    this.value = null;
    this.speed = 0;
  }

  /** Filters one sample taken at time tS (seconds). Repeated or backwards times keep the last value. */
  filter(x: number, tS: number): number {
    if (this.value === null) {
      this.value = x;
      this.speed = 0;
      this.lastS = tS;
      return x;
    }
    const dt = tS - this.lastS;
    if (!(dt > 0)) return this.value;
    this.lastS = tS;
    const rawSpeed = (x - this.value) / dt;
    const o = this.options;
    this.speed += smoothingFactor(o.derivativeCutoffHz, dt) * (rawSpeed - this.speed);
    const cutoff = o.minCutoffHz + o.beta * Math.abs(this.speed);
    this.value += smoothingFactor(cutoff, dt) * (x - this.value);
    return this.value;
  }
}

/** One filter per axis. */
export class OneEuroFilter3 {
  private readonly axes: [OneEuroFilter, OneEuroFilter, OneEuroFilter];

  constructor(options: readonly [OneEuroOptions, OneEuroOptions, OneEuroOptions]) {
    this.axes = [new OneEuroFilter(options[0]), new OneEuroFilter(options[1]), new OneEuroFilter(options[2])];
  }

  reset(): void {
    for (const axis of this.axes) axis.reset();
  }

  filter(x: readonly [number, number, number], tS: number): [number, number, number] {
    return [this.axes[0].filter(x[0], tS), this.axes[1].filter(x[1], tS), this.axes[2].filter(x[2], tS)];
  }
}
