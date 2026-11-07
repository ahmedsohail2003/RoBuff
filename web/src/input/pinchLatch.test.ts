import { describe, expect, it } from 'vitest';
import { PinchLatch } from './pinchLatch';

const OPTIONS = { closeBelow: 0.3, openAbove: 0.5, confirmFrames: 2 };

function transitions(states: readonly boolean[]): number {
  return states.reduce((count, state, i) => count + (i > 0 && state !== states[i - 1] ? 1 : 0), 0);
}

describe('PinchLatch', () => {
  it('closes after the ratio stays below the close threshold, and opens only above the open threshold', () => {
    const latch = new PinchLatch(OPTIONS);
    expect(latch.update(0.9)).toBe(false);
    expect(latch.update(0.25)).toBe(false); // one frame is not enough
    expect(latch.update(0.25)).toBe(true);
    expect(latch.update(0.45)).toBe(true); // between the thresholds: stays closed
    expect(latch.update(0.45)).toBe(true);
    expect(latch.update(0.55)).toBe(true);
    expect(latch.update(0.55)).toBe(false);
  });

  it('does not flap when the ratio hovers on the close threshold', () => {
    const latch = new PinchLatch(OPTIONS);
    const states: boolean[] = [];
    for (let i = 0; i < 400; i++) states.push(latch.update(0.3 + 0.04 * Math.sin(i * 1.7) + 0.02 * Math.sin(i * 0.31)));
    expect(transitions(states)).toBeLessThanOrEqual(1);
    expect(latch.closed).toBe(true);
  });

  it('does not flap when the ratio hovers on the open threshold', () => {
    const latch = new PinchLatch(OPTIONS);
    latch.update(0.1);
    latch.update(0.1);
    const states: boolean[] = [];
    for (let i = 0; i < 400; i++) states.push(latch.update(0.5 + 0.04 * Math.sin(i * 1.3) + 0.02 * Math.sin(i * 0.17)));
    expect(transitions(states)).toBeLessThanOrEqual(1);
  });

  it('ignores single-frame spikes', () => {
    const latch = new PinchLatch(OPTIONS);
    for (let i = 0; i < 50; i++) expect(latch.update(i % 2 ? 0.1 : 0.9)).toBe(false);
  });

  it('treats NaN as no change', () => {
    const latch = new PinchLatch(OPTIONS);
    latch.update(0.1);
    latch.update(0.1);
    expect(latch.update(Number.NaN)).toBe(true);
    expect(latch.update(Number.NaN)).toBe(true);
  });

  it('rejects thresholds in the wrong order', () => {
    expect(() => new PinchLatch({ closeBelow: 0.5, openAbove: 0.3, confirmFrames: 2 })).toThrow();
  });
});
