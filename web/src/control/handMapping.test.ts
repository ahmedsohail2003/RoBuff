import { beforeAll, describe, expect, it } from 'vitest';
import { cubePickPlan } from '../input/scene';
import { pickPhases } from '../input/pickScript';
import { SyntheticSource } from '../input/syntheticSource';
import { StopLatch } from '../safety/latch';
import { GRIPPER_SITE } from '../sim/armXml';
import { loadNode } from '../sim/loadModelNode';
import { Simulation, type Vec3 } from '../sim/simulation';
import { ArmController } from './armController';
import { ControlLoop } from './controlLoop';
import { HAND_WORKSPACE, handRangeText, handToCommand, palmToWorld } from './handMapping';
import { ArmIk } from './ik';
import { ARM_WORKSPACE } from './workspace';

const reach = (p: Vec3) => Math.hypot(p[0] - HAND_WORKSPACE.shoulder[0], p[1] - HAND_WORKSPACE.shoulder[1], p[2] - HAND_WORKSPACE.shoulder[2]);

/** Same algebra as worldToPalm, kept here so the test does not lean on the code under test. */
function palmFor(world: Vec3): Vec3 {
  return [0.5 - world[0] / 0.5, 1 - (world[2] - 0.01) / 0.25, (-0.1 - world[1]) / 0.3];
}

let loop: ControlLoop;

beforeAll(async () => {
  const { mujoco, model } = await loadNode();
  const sim = new Simulation(mujoco, model);
  loop = new ControlLoop(sim, new ArmController(sim, new ArmIk(mujoco, model, GRIPPER_SITE)));
}, 60_000);

describe('hand target clamp (M1 step 9)', () => {
  it('keeps every corner of the picture inside the hand workspace, short of full reach', () => {
    let worstRaw = 0;
    for (const x of [0, 1]) {
      for (const y of [0, 1]) {
        for (const depth of [0, 1]) {
          worstRaw = Math.max(worstRaw, reach(palmToWorld([x, y, depth])));
          const command = handToCommand({ palm: [x, y, depth], pinch: 0, confidence: 1, tMs: 0 })!;
          expect(reach(command.target)).toBeLessThanOrEqual(HAND_WORKSPACE.maxReach + 1e-9);
          expect(command.target[2]).toBeLessThanOrEqual(HAND_WORKSPACE.maxZ + 1e-9);
          expect(command.target[2]).toBeGreaterThanOrEqual(HAND_WORKSPACE.minZ - 1e-9);
          const radius = Math.hypot(command.target[0] - HAND_WORKSPACE.baseAxis[0], command.target[1] - HAND_WORKSPACE.baseAxis[1]);
          expect(radius).toBeGreaterThanOrEqual(HAND_WORKSPACE.minRadius - 1e-9);
        }
      }
    }
    // The raw map does reach past the arm: that is what the clamp is for.
    expect(worstRaw).toBeGreaterThan(ARM_WORKSPACE.maxReach);
    expect(HAND_WORKSPACE.maxReach).toBeLessThan(ARM_WORKSPACE.maxReach);
  });

  it('flags a clamped target and leaves a target in range untouched', () => {
    const centre = handToCommand({ palm: [0.5, 0.5, 0.5], pinch: 1, confidence: 1, tMs: 0 })!;
    expect(centre.clamped).toBe(false);
    expect(centre.target).toEqual(palmToWorld([0.5, 0.5, 0.5]));
    const corner = handToCommand({ palm: [0, 0, 1], pinch: 0, confidence: 1, tMs: 0 })!;
    expect(corner.clamped).toBe(true);
  });

  it('does not move any waypoint of the scripted cube pick', () => {
    loop.reset();
    const plan = cubePickPlan(loop.sim);
    for (const point of [plan.start, ...pickPhases(plan).map((phase) => phase.waypoint)]) {
      const command = handToCommand({ palm: palmFor(point), pinch: 0, confidence: 1, tMs: 0 })!;
      command.target.forEach((value, i) => expect(value).toBeCloseTo(point[i]!, 9));
      expect(command.clamped).toBe(false);
    }
  });

  it('describes the range with the numbers it uses', () => {
    expect(handRangeText()).toBe('hand range: 50 cm side to side, 1-26 cm high, 10-40 cm out; kept within 29 cm of the shoulder (arm reach 33 cm)');
  });
});

describe('stop latch in the control loop (M1 step 5)', () => {
  it('holds every actuator command, jaw included, while physics runs on, and lets go on clear', () => {
    loop.reset();
    loop.source = new SyntheticSource(() => cubePickPlan(loop.sim));
    const latch = new StopLatch();
    loop.stopLatch = latch;
    try {
      // Into the pick, while the jaw closes on the cube.
      while (loop.sim.time < 4.5) loop.advance(10);
      latch.stop('test', loop.sim.time);
      const ctrl = [...loop.sim.getCtrl()];
      const start = loop.sim.time;
      while (loop.sim.time < start + 2) {
        loop.advance(10);
        expect(loop.sim.getCtrl()).toEqual(ctrl);
      }
      expect(loop.sim.time - start).toBeGreaterThanOrEqual(2);
      latch.clear();
      loop.advance(50);
      expect(loop.sim.getCtrl().some((value, i) => Math.abs(value - ctrl[i]!) > 1e-6)).toBe(true);
    } finally {
      loop.stopLatch = null;
      loop.source = null;
    }
  });
});
