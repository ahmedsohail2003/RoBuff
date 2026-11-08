// A delay line keyed by simulated time: a ring buffer of (time, value) entries. push adds the
// newest entry; read(t) gives the newest entry at or before t. The Earth-Moon command line and
// view line are two of these, each read D seconds behind the clock.

/** Mean Earth-Moon distance, NASA NSSDC Moon fact sheet (semimajor axis 0.3844 x 10^6 km). */
export const EARTH_MOON_KM = 384_400;
/** Speed of light in vacuum, km/s (exact, SI definition). */
export const LIGHT_KM_S = 299_792.458;
/** One-way light time Earth-Moon, rounded to the control tick: 384,400 / 299,792.458 = 1.2822 s. */
export const ONE_WAY_DELAY_S = 1.28;
export const ROUND_TRIP_S = 2 * ONE_WAY_DELAY_S;

/** Times within this of each other count as the same tick (sums of 2 ms steps drift by ~1e-15). */
const TIME_EPS = 1e-6;

export interface Entry<T> {
  t: number;
  value: T;
}

export class DelayLine<T> {
  private readonly times: Float64Array;
  private readonly values: (T | undefined)[];
  private head = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    if (!(capacity >= 1)) throw new Error('a delay line needs room for at least one entry');
    this.times = new Float64Array(capacity);
    this.values = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  /** Adds an entry. Times must not go backwards; clear() first after a reset. */
  push(t: number, value: T): void {
    if (this.count > 0 && t < this.times[(this.head - 1 + this.capacity) % this.capacity]! - TIME_EPS) {
      throw new Error(`delay line time went backwards (${t} after ${this.newest()!.t}); clear it after a reset`);
    }
    this.times[this.head] = t;
    this.values[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }

  /** The newest entry at or before t, or null if every entry is newer (or the line is empty). */
  read(t: number): Entry<T> | null {
    // Newest first: reads are near the end that is D behind the head, so a short walk.
    for (let k = 0; k < this.count; k++) {
      const i = (this.head - 1 - k + 2 * this.capacity) % this.capacity;
      if (this.times[i]! <= t + TIME_EPS) return { t: this.times[i]!, value: this.values[i] as T };
    }
    return null;
  }

  oldest(): Entry<T> | null {
    if (this.count === 0) return null;
    const i = (this.head - this.count + this.capacity) % this.capacity;
    return { t: this.times[i]!, value: this.values[i] as T };
  }

  newest(): Entry<T> | null {
    if (this.count === 0) return null;
    const i = (this.head - 1 + this.capacity) % this.capacity;
    return { t: this.times[i]!, value: this.values[i] as T };
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.values.fill(undefined);
  }
}

/** The delay line text for the screen, with its numbers. */
export function delayText(): string {
  return `${ONE_WAY_DELAY_S.toFixed(2)} s each way, ${ROUND_TRIP_S.toFixed(2)} s round trip: ${EARTH_MOON_KM.toLocaleString('en-US')} km Earth-Moon at light speed (${Math.round(LIGHT_KM_S).toLocaleString('en-US')} km/s)`;
}
