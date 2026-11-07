import { describe, expect, it } from 'vitest';
import { GRIP_RATE_PER_S, slew } from './grip';

describe('grip slew', () => {
  it('takes a full stroke in 1 / GRIP_RATE_PER_S seconds, never faster', () => {
    const dt = 0.01;
    let value = 0;
    let steps = 0;
    while (value < 1) {
      const next = slew(value, 1, GRIP_RATE_PER_S, dt);
      expect(next - value).toBeLessThanOrEqual(GRIP_RATE_PER_S * dt + 1e-12);
      value = next;
      steps++;
    }
    expect(steps * dt).toBeCloseTo(1 / GRIP_RATE_PER_S, 6);
  });

  it('lands exactly on the goal without overshoot', () => {
    expect(slew(0.99, 1, GRIP_RATE_PER_S, 0.01)).toBe(1);
    expect(slew(0.01, 0, GRIP_RATE_PER_S, 0.01)).toBe(0);
  });
});
