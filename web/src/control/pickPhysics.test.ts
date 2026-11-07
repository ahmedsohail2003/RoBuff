import { beforeAll, describe, expect, it } from 'vitest';
import { cubePickPlan, CUBE_BODY } from '../input/scene';
import { SyntheticSource } from '../input/syntheticSource';
import { GRIPPER_SITE } from '../sim/armXml';
import { loadNode } from '../sim/loadModelNode';
import { Simulation } from '../sim/simulation';
import { ArmController } from './armController';
import { ControlLoop } from './controlLoop';
import { ArmIk } from './ik';
import { evaluatePick, jawContactSummary, type PickReport, type PickSample } from './pickCheck';
import type { PickSample as ScriptSample } from '../input/pickScript';

/** Physics steps between samples: 10 x 2 ms. */
const SAMPLE_EVERY = 10;
const RUN_SECONDS = 16.5;

let loop: ControlLoop;

beforeAll(async () => {
  const { mujoco, model } = await loadNode();
  const sim = new Simulation(mujoco, model);
  loop = new ControlLoop(sim, new ArmController(sim, new ArmIk(mujoco, model, GRIPPER_SITE)));
  loop.source = new SyntheticSource(() => cubePickPlan(sim));
}, 60_000);

/** The same scripted pick the browser test runs, stepped headless in Node. */
function runPick(): PickReport {
  loop.reset();
  const sim = loop.sim;
  const restZ = sim.getBodyPos(CUBE_BODY)![2];
  const samples: PickSample[] = [];
  while (sim.time < RUN_SECONDS) {
    loop.advance(SAMPLE_EVERY);
    const script = loop.source!.describe() as unknown as ScriptSample & { phase: string };
    samples.push({
      t: sim.time,
      phase: script.phase,
      phaseIndex: script.phaseIndex,
      settled: script.settled,
      waypoint: script.waypoint,
      site: sim.getSitePos(GRIPPER_SITE)!,
      cube: sim.getBodyPos(CUBE_BODY)!,
      grip: loop.controller.status().grip ?? 0,
      ...jawContactSummary(sim.contactsOf(CUBE_BODY)),
    });
  }
  return evaluatePick(samples, restZ);
}

describe('scripted pick in the physics engine', () => {
  it('lifts the 3 cm cube by friction, holds it, and drops it on opening', () => {
    const report = runPick();
    console.log(`PICK_NODE ${JSON.stringify(report)}`);
    expect(report.failures).toEqual([]);
  });

  it('gives the same result after a reset', () => {
    const first = runPick();
    const second = runPick();
    expect(second.maxRise).toBe(first.maxRise);
    expect(second.heldS).toBe(first.heldS);
  });
});
