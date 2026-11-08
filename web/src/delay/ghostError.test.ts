import { describe, expect, it } from 'vitest';
import { ErrorStats, distanceMm, errorCue, errorLevel, ghostError } from './ghostError';

describe('ghost error meter', () => {
  it('colours: green under 5 mm, amber to 20 mm, red above with "wait for truth"', () => {
    expect(errorLevel(0)).toBe('green');
    expect(errorLevel(4.99)).toBe('green');
    expect(errorLevel(5)).toBe('amber');
    expect(errorLevel(20)).toBe('amber');
    expect(errorLevel(20.01)).toBe('red');
    expect(errorCue('red')).toBe('wait for truth');
  });

  it('measures gripper and rock in mm, and the level follows the larger', () => {
    expect(distanceMm([0, 0, 0], [0.003, 0.004, 0])).toBeCloseTo(5, 9);
    const e = ghostError({ gripper: [0, 0, 0.1], rock: [0, -0.22, 0.05] }, { gripper: [0, 0, 0.102], rock: [0, -0.22, 0.075] });
    expect(e.gripper_mm).toBeCloseTo(2, 9);
    expect(e.rock_mm).toBeCloseTo(25, 9);
    expect(e.level).toBe('red');
    expect(ghostError({ gripper: [0, 0, 0], rock: null }, { gripper: [0, 0, 0], rock: [0, 0, 0] }).rock_mm).toBeNull();
  });

  it('keeps a running max and mean, ignoring non-finite values', () => {
    const s = new ErrorStats();
    expect(s.max).toBeNull();
    expect(s.mean).toBeNull();
    for (const v of [1, 3, Number.NaN, 8]) s.add(v);
    expect(s.max).toBe(8);
    expect(s.mean).toBe(4);
    expect(s.count).toBe(3);
  });
});
