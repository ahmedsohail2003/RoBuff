import { describe, expect, it } from 'vitest';
import { dampedLeastSquares, solveSpd } from './linalg';

describe('solveSpd', () => {
  it('solves a symmetric positive definite system', () => {
    const a = new Float64Array([4, 1, 0, 1, 3, 1, 0, 1, 2]);
    const x = solveSpd(a, new Float64Array([1, 2, 3]), 3)!;
    const back = [0, 1, 2].map((i) => a[3 * i]! * x[0]! + a[3 * i + 1]! * x[1]! + a[3 * i + 2]! * x[2]!);
    back.forEach((value, i) => expect(value).toBeCloseTo([1, 2, 3][i]!, 12));
  });

  it('refuses a matrix that is not positive definite', () => {
    expect(solveSpd(new Float64Array([1, 2, 2, 1]), new Float64Array([1, 1]), 2)).toBeNull();
  });
});

describe('dampedLeastSquares', () => {
  it('matches the exact inverse for a square system with no damping', () => {
    const j = new Float64Array([2, 0, 1, 3]);
    const dq = dampedLeastSquares(j, new Float64Array([4, 5]), 2, 2, 0)!;
    expect(dq[0]).toBeCloseTo(2, 12);
    expect(dq[1]).toBeCloseTo(1, 12);
  });

  it('stays finite and small at a singular Jacobian', () => {
    const dq = dampedLeastSquares(new Float64Array([1, 1, 1, 1]), new Float64Array([1, -1]), 2, 2, 0.05)!;
    dq.forEach((value) => {
      expect(Number.isFinite(value)).toBe(true);
      expect(Math.abs(value)).toBeLessThan(1);
    });
  });
});
