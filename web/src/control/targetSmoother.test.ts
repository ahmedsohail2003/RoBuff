import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../sim/simulation';
import { TargetSmoother } from './targetSmoother';
import { ARM_WORKSPACE, clampTarget } from './workspace';

describe('TargetSmoother', () => {
  it('never moves faster than its speed limit and settles on the goal', () => {
    const smoother = new TargetSmoother({ timeConstantS: 0.1, maxSpeed: 0.2 });
    smoother.reset([0, 0, 0]);
    const dt = 0.01;
    let previous: Vec3 = [0, 0, 0];
    for (let i = 0; i < 300; i++) {
      const next = smoother.step([0.3, 0, 0], dt);
      expect(Math.hypot(next[0] - previous[0], next[1] - previous[1], next[2] - previous[2])).toBeLessThanOrEqual(0.2 * dt + 1e-12);
      previous = next;
    }
    expect(previous[0]).toBeCloseTo(0.3, 4);
  });
});

describe('clampTarget', () => {
  it('leaves a point inside the workspace alone', () => {
    expect(clampTarget([0.01, -0.22, 0.05])).toEqual([0.01, -0.22, 0.05]);
  });

  it('keeps the gripper above the floor and below the ceiling', () => {
    expect(clampTarget([0, -0.22, -0.2])[2]).toBe(ARM_WORKSPACE.minZ);
    expect(clampTarget([0, -0.15, 2])[2]).toBeLessThanOrEqual(ARM_WORKSPACE.maxZ);
  });

  it('pulls a far point back within reach of the shoulder', () => {
    const [x, y, z] = clampTarget([0, -1, 0.1]);
    const s = ARM_WORKSPACE.shoulder;
    expect(Math.hypot(x - s[0], y - s[1], z - s[2])).toBeLessThanOrEqual(ARM_WORKSPACE.maxReach + 1e-9);
  });

  it('pushes a point on the base axis forward', () => {
    const [x, y] = clampTarget([ARM_WORKSPACE.baseAxis[0], ARM_WORKSPACE.baseAxis[1], 0.05]);
    expect(x).toBeCloseTo(0, 9);
    expect(y).toBeCloseTo(ARM_WORKSPACE.baseAxis[1] - ARM_WORKSPACE.minRadius, 9);
  });
});
