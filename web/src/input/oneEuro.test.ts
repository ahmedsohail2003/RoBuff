import { describe, expect, it } from 'vitest';
import { OneEuroFilter, type OneEuroOptions } from './oneEuro';

/** Seeded uniform noise in [-1, 1], so every run sees the same jitter. */
function noise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

const OPTIONS: OneEuroOptions = { minCutoffHz: 1, beta: 2, derivativeCutoffHz: 1 };
const DT = 1 / 30;

function std(values: readonly number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
}

describe('OneEuroFilter', () => {
  it('passes the first sample through and holds a constant exactly', () => {
    const filter = new OneEuroFilter(OPTIONS);
    expect(filter.filter(0.4, 0)).toBe(0.4);
    for (let i = 1; i < 100; i++) expect(filter.filter(0.4, i * DT)).toBeCloseTo(0.4, 12);
  });

  it('cuts jitter on a still hand by more than 2x', () => {
    const filter = new OneEuroFilter(OPTIONS);
    const random = noise(7);
    const raw: number[] = [];
    const out: number[] = [];
    for (let i = 0; i < 300; i++) {
      const x = 0.5 + 0.01 * random();
      raw.push(x);
      const y = filter.filter(x, i * DT);
      if (i >= 30) out.push(y);
    }
    console.log(`ONE_EURO_JITTER_REDUCTION ${(std(raw.slice(30)) / std(out)).toFixed(2)}x`);
    expect(std(out)).toBeLessThan(std(raw.slice(30)) / 2);
  });

  it('lags less on a fast move than a fixed filter with the same still-hand cutoff', () => {
    const adaptive = new OneEuroFilter(OPTIONS);
    const fixed = new OneEuroFilter({ ...OPTIONS, beta: 0 });
    let adaptiveLag = 0;
    let fixedLag = 0;
    for (let i = 0; i <= 30; i++) {
      const x = i * DT * 1.0; // 1 image width per second
      adaptiveLag = x - adaptive.filter(x, i * DT);
      fixedLag = x - fixed.filter(x, i * DT);
    }
    expect(adaptiveLag).toBeGreaterThan(0);
    console.log(`ONE_EURO_LAG adaptive ${adaptiveLag.toFixed(4)} fixed ${fixedLag.toFixed(4)} (image widths at 1 width/s)`);
    expect(adaptiveLag).toBeLessThan(fixedLag / 2);
  });

  it('ignores a repeated or backwards timestamp instead of dividing by zero', () => {
    const filter = new OneEuroFilter(OPTIONS);
    filter.filter(0.2, 1);
    expect(filter.filter(0.9, 1)).toBe(0.2);
    expect(filter.filter(0.9, 0.5)).toBe(0.2);
    expect(Number.isFinite(filter.filter(0.3, 1 + DT))).toBe(true);
  });

  it('starts over at the new value after reset', () => {
    const filter = new OneEuroFilter(OPTIONS);
    for (let i = 0; i < 10; i++) filter.filter(0.1, i * DT);
    filter.reset();
    expect(filter.filter(0.8, 5)).toBe(0.8);
  });
});
