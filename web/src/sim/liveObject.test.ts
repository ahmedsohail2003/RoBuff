import { beforeAll, describe, expect, it } from 'vitest';
import { jawAngleForGap } from './liftTester';
import { jawAngleForGapScratch, jawContacts, liveObject, slotBodyName } from './liveObject';
import { loadNode } from './loadModelNode';
import type { Mujoco } from './mujocoRuntime';
import { Simulation } from './simulation';
import type { MjModel } from '@mujoco/mujoco';

let mujoco: Mujoco;
let model: MjModel;
beforeAll(async () => {
  ({ mujoco, model } = await loadNode());
}, 60_000);

describe('the live object', () => {
  it('reads the arena cube: 8 box corners, 30 mm tall on the floor, no jaw on it', () => {
    const sim = new Simulation(mujoco, model);
    sim.step(200);
    expect(slotBodyName(mujoco, sim)).toBe('cube');
    const cube = liveObject(mujoco, sim, 'cube');
    expect(cube.points.length).toBe(24);
    expect(cube.height).toBeCloseTo(0.03, 4);
    expect(cube.lowest).toBeLessThan(0.001);
    expect(cube.com[1]).toBeCloseTo(-0.22, 3);
    expect(jawContacts(sim, 'cube')).toEqual([]);
  });

  it('finds the jaw angle for a gap on a scratch copy, never touching the live qpos', () => {
    const sim = new Simulation(mujoco, model);
    const before = Array.from(sim.mjData.qpos as Float64Array);
    const scratch = jawAngleForGapScratch(mujoco, sim, 0.046);
    expect(Array.from(sim.mjData.qpos as Float64Array)).toEqual(before);
    expect(scratch).toBeCloseTo(jawAngleForGap(mujoco, sim, 0.046), 6);
    expect(scratch).toBeCloseTo(0.39, 2);
  });
});
