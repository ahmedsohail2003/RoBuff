import { beforeAll, describe, expect, it } from 'vitest';
import type { MjModel } from '@mujoco/mujoco';
import { loadNode } from './loadModelNode';
import type { Mujoco } from './mujocoRuntime';
import { BENNU_ESCAPE_M_S, BENNU_SURFACE_G, GRAVITY_PRESETS, GravityRegistry, readGravity } from './gravity';
import { Simulation } from './simulation';

const HALF = 0.015;

let mujoco: Mujoco;
let first: MjModel;
let second: MjModel;

beforeAll(async () => {
  ({ mujoco, model: first } = await loadNode());
  ({ model: second } = await loadNode());
});

/** Drops the arena cube with its lowest point at height; returns the first floor-contact time. */
function drop(sim: Simulation, height: number, seconds: number): { contactS: number | null; endLowest: number } {
  sim.reset();
  sim.placeFreeBody('cube', [0.2, -0.25, height + HALF]);
  const start = sim.time;
  let contactS: number | null = null;
  for (let i = 0; i < Math.round(seconds / sim.timestep); i++) {
    sim.step(1);
    if (contactS === null && sim.contactsOf('cube').some((c) => c.geom1 === 'floor' || c.geom2 === 'floor')) contactS = sim.time - start;
  }
  return { contactS, endLowest: sim.getBodyPos('cube')![2] - HALF };
}

describe('gravity registry', () => {
  it('Bennu values are calculated from GM and diameter: about 8.3e-5 m/s2 and 0.20 m/s', () => {
    expect(BENNU_SURFACE_G).toBeCloseTo(8.3e-5, 6);
    expect(BENNU_ESCAPE_M_S).toBeCloseTo(0.2, 2);
    expect(GRAVITY_PRESETS.map((p) => p.value)).toEqual([9.82, 3.73, 1.62, 8.3e-5, 0]);
  });

  it('writes gravity live on every registered simulation, and follows a swapped model', () => {
    const registry = new GravityRegistry();
    let live: MjModel = first;
    registry.register('live', () => live);
    registry.register('ghost', () => second);
    // Registering gives the model the current setting (Earth, 9.82) in place of MuJoCo's 9.81.
    expect(readGravity(first)).toBeCloseTo(9.82, 10);
    registry.set('moon');
    expect(registry.report()).toEqual([
      { name: 'live', gravity_m_s2: 1.62 },
      { name: 'ghost', gravity_m_s2: 1.62 },
    ]);
    // The live slot now returns the other model: the next change reaches it.
    live = second;
    registry.set('mars');
    expect(readGravity(second)).toBeCloseTo(3.73, 10);
    const unregister = registry.register('extra', () => first);
    expect(readGravity(first)).toBeCloseTo(3.73, 10);
    unregister();
    registry.set('orbit');
    expect(readGravity(first)).toBeCloseTo(3.73, 10);
    expect(readGravity(second)).toBe(0);
  });

  it('a cube released from 0.10 m reaches the floor in about sqrt(2h/g): Moon 0.35 s, Earth 0.14 s; on Bennu it is still above 0.09 m after 5 s', () => {
    const registry = new GravityRegistry();
    const sim = new Simulation(mujoco, first);
    registry.register('live', () => sim.model);
    registry.set('moon');
    const moon = drop(sim, 0.1, 0.6);
    registry.set('earth');
    const earth = drop(sim, 0.1, 0.4);
    registry.set('bennu');
    const bennu = drop(sim, 0.1, 5);
    console.log(`M3_DROP ${JSON.stringify({ moon_s: moon.contactS, earth_s: earth.contactS, bennu_after_5s_m: bennu.endLowest, bennu_contact: bennu.contactS })}`);
    expect(moon.contactS).not.toBeNull();
    expect(Math.abs(moon.contactS! - Math.sqrt(0.2 / 1.62))).toBeLessThan(0.01);
    expect(Math.abs(moon.contactS! - 0.35)).toBeLessThan(0.05);
    expect(Math.abs(earth.contactS! - Math.sqrt(0.2 / 9.82))).toBeLessThan(0.01);
    expect(bennu.contactS).toBeNull();
    expect(bennu.endLowest).toBeGreaterThan(0.09);
  });
});
