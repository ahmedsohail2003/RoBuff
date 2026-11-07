import type { MjModel } from '@mujoco/mujoco';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GRIPPER_SITE } from '../sim/armXml';
import { loadNode } from '../sim/loadModelNode';
import type { Mujoco } from '../sim/mujocoRuntime';
import type { Vec3 } from '../sim/simulation';
import { closingYawFor } from './grasp';
import { ArmIk, IK_JOINTS } from './ik';
import { ARM_WORKSPACE, clampTarget } from './workspace';

const HOME = [0, -1.57, 1.57, 1.57, -1.57];
let mujoco: Mujoco;
let model: MjModel;
let ik: ArmIk;
/** Joint ranges straight from the compiled model, not from the solver. */
let modelRanges: [number, number][];

beforeAll(async () => {
  ({ mujoco, model } = await loadNode());
  ik = new ArmIk(mujoco, model, GRIPPER_SITE);
  const range = model.jnt_range as Float64Array;
  modelRanges = IK_JOINTS.map((joint) => {
    const id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT.value, joint);
    return [range[2 * id]!, range[2 * id + 1]!];
  });
}, 60_000);

afterAll(() => ik?.dispose());

function solve(target: Vec3, iterations = 300) {
  return ik.solve({ position: target, closingYaw: closingYawFor(target) }, HOME, iterations);
}

function expectWithinLimits(q: number[]): void {
  expect(q).toHaveLength(IK_JOINTS.length);
  q.forEach((value, i) => {
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(modelRanges[i]![0]);
    expect(value).toBeLessThanOrEqual(modelRanges[i]![1]);
  });
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

describe('ArmIk', () => {
  it.each<[string, Vec3]>([
    ['the cube grasp point', [0.009, -0.22, 0.022]],
    ['above the cube', [0.009, -0.22, 0.092]],
    ['off to the side', [0.1, -0.2, 0.05]],
    ['the other side, close in', [-0.12, -0.15, 0.04]],
    ['far out and high', [0.05, -0.3, 0.15]],
  ])('converges to within 1 cm of a reachable target: %s', (_, target) => {
    const result = solve(target);
    // Check with an independent forward kinematics call, not the solver's own report.
    const reached = ik.forward(result.q);
    console.log(`IK ${JSON.stringify(target)} error ${(distance(reached, target) * 1000).toFixed(2)} mm, tilt ${((result.pointingError * 180) / Math.PI).toFixed(1)} deg, ${result.iterations} iterations`);
    expect(distance(reached, target)).toBeLessThan(0.01);
    expectWithinLimits(result.q);
  });

  it('keeps the jaws pointing down where the arm can', () => {
    const result = solve([0.009, -0.22, 0.022]);
    expect(result.pointingError).toBeLessThan((3 * Math.PI) / 180);
  });

  it.each<[string, Vec3]>([
    ['far in front', [0, -0.8, 0.1]],
    ['far above', [0, -0.1, 1.2]],
    ['far behind and below the floor', [0.4, 0.6, -0.5]],
  ])('clamps an unreachable target with no NaN and the joint limits held: %s', (_, target) => {
    const result = solve(target, 500);
    expectWithinLimits(result.q);
    expect(Number.isFinite(result.positionError)).toBe(true);
    const reached = ik.forward(result.q);
    reached.forEach((value) => expect(Number.isFinite(value)).toBe(true));
    // It got as close as it could: no closer than the reach allows, and it did move.
    expect(result.positionError).toBeGreaterThan(0.05);
    expect(distance(reached, target)).toBeLessThan(distance(ik.forward(HOME), target));
  });

  it('never leaves the joint limits for 200 random targets', () => {
    let seed = 12345;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 200; i++) {
      const target: Vec3 = [random() - 0.5, random() - 0.8, random() * 0.6 - 0.1];
      expectWithinLimits(ik.solve({ position: target, closingYaw: closingYawFor(target) }, HOME, 40).q);
    }
  });

  it('returns a finite answer for a NaN target, and the workspace clamp removes the NaN', () => {
    const raw = ik.solve({ position: [Number.NaN, -0.2, 0.05], closingYaw: 0 }, HOME, 20);
    expectWithinLimits(raw.q);
    clampTarget([Number.NaN, -0.2, Number.POSITIVE_INFINITY]).forEach((value) => expect(Number.isFinite(value)).toBe(true));
  });
});

describe('a target inside the base', () => {
  const insideBase: Vec3 = [0, -0.05, 0.03];

  it('is moved out of the base column by the workspace clamp', () => {
    const clamped = clampTarget(insideBase);
    const radius = Math.hypot(clamped[0] - ARM_WORKSPACE.baseAxis[0], clamped[1] - ARM_WORKSPACE.baseAxis[1]);
    expect(radius).toBeGreaterThanOrEqual(ARM_WORKSPACE.minRadius - 1e-9);
    expect(clamped[2]).toBeCloseTo(insideBase[2], 9);
  });

  it('then converges to within 1 cm of the clamped point', () => {
    const clamped = clampTarget(insideBase);
    const result = solve(clamped, 500);
    expectWithinLimits(result.q);
    console.log(`IK inside-base clamped to ${JSON.stringify(clamped.map((v) => +v.toFixed(4)))}, error ${(distance(ik.forward(result.q), clamped) * 1000).toFixed(2)} mm`);
    expect(distance(ik.forward(result.q), clamped)).toBeLessThan(0.01);
  });

  it('does not break the solver even unclamped', () => {
    const result = solve(insideBase, 500);
    expectWithinLimits(result.q);
    expect(Number.isFinite(result.positionError)).toBe(true);
  });
});
