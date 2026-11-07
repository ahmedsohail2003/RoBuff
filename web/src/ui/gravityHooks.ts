// Debug hooks for gravity and the space scene, added to window.__sim in dev and test builds only.

import type { App } from '../app';
import type { SpaceScene } from '../render/spaceScene';
import { gravity, isGravityId, type GravityPreset } from '../sim/gravity';
import type { Vec3 } from '../sim/simulation';
import type { EscapeReadout, GravityMenu } from './gravityMenu';

/** Half the side of the arena cube (arena.xml). */
const CUBE_HALF = 0.015;
const CUBE = 'cube';

export interface DropReport {
  gravity_m_s2: number;
  /** Height of the cube's lowest point above the floor at release, in metres. */
  release_height_m: number;
  /** Simulated seconds from release to the first cube-floor contact, or null if it never touched. */
  floor_contact_s: number | null;
  /** The cube's lowest point at the end, in metres. */
  end_height_m: number;
  seconds: number;
  /** Bodies other than the floor the cube touched on the way down (should be none). */
  other_contacts: string[];
}

export interface GravityHook {
  /** Picks a gravity setting as the menu does. Returns the preset and what each registered simulation now holds. */
  setGravity(id: string): { preset: GravityPreset; sims: { name: string; gravity_m_s2: number | null }[] };
  gravity(): { preset: GravityPreset; sims: { name: string; gravity_m_s2: number | null }[] };
  /**
   * Resets the scene, holds the cube still with its lowest point at height above (x, y), lets
   * go, and steps the live control loop for the given simulated seconds in one go (the page
   * does not draw meanwhile), timing the first floor contact.
   */
  dropCube(height: number, seconds: number, xy?: [number, number]): DropReport;
  /** Sets the slot body's linear velocity (m/s, world frame); spin is zeroed. */
  launchSlotBody(velocity: Vec3): void;
  /** Steps the live control loop for this many simulated seconds in one go. */
  advanceSim(seconds: number): void;
  /** Star count, draw calls the stars add (measured by rendering with and without them), sky colour. */
  spaceScene(): { starCount: number; starDrawCalls: number; background: string };
  /** The Bennu escape readout as last drawn, or null when not on Bennu. */
  escape(): EscapeReadout | null;
}

declare module '../test-hooks' {
  interface SimHook extends Partial<GravityHook> {}
}

function lowest(app: App): number {
  const pos = app.sim.getBodyPos(CUBE);
  if (!pos) throw new Error('the scene has no cube (an object was spawned); reload the page');
  return pos[2] - CUBE_HALF;
}

export function installGravityHooks(app: App, menu: GravityMenu, space: SpaceScene): void {
  const target = window.__sim;
  if (!target) return;
  const status = () => ({ preset: gravity.current, sims: gravity.report() });
  const hooks: GravityHook = {
    setGravity: (id) => {
      if (!isGravityId(id)) throw new Error(`unknown gravity ${id}`);
      gravity.set(id);
      return status();
    },
    gravity: status,
    dropCube: (height, seconds, xy = [0.2, -0.25]) => {
      const loop = app.loop;
      loop.reset((sim) => sim.placeFreeBody(CUBE, [xy[0], xy[1], height + CUBE_HALF]));
      const sim = app.sim;
      const start = sim.time;
      const steps = Math.round(seconds / sim.timestep);
      let contactAt: number | null = null;
      const others = new Set<string>();
      for (let i = 0; i < steps; i++) {
        loop.advance(1);
        for (const contact of sim.contactsOf(CUBE)) {
          const other = contact.body1 === CUBE ? contact.body2 : contact.body1;
          const geom = contact.body1 === CUBE ? contact.geom2 : contact.geom1;
          if (geom === 'floor') contactAt ??= sim.time - start;
          else others.add(other);
        }
      }
      return {
        gravity_m_s2: gravity.current.value,
        release_height_m: height,
        floor_contact_s: contactAt,
        end_height_m: lowest(app),
        seconds: sim.time - start,
        other_contacts: [...others],
      };
    },
    launchSlotBody: (velocity) => {
      const sim = app.sim;
      const model = sim.model;
      const body = model.nbody - 1;
      const joint = (model.body_jntadr as Int32Array)[body]!;
      if (joint < 0) throw new Error('the slot body has no joint');
      const dadr = (model.jnt_dofadr as Int32Array)[joint]!;
      const qvel = sim.mjData.qvel as Float64Array;
      qvel.set([...velocity, 0, 0, 0], dadr);
    },
    advanceSim: (seconds) => app.loop.advance(Math.round(seconds / app.sim.timestep)),
    spaceScene: () => ({
      starCount: space.starCount,
      starDrawCalls: space.measureStarDrawCalls(),
      background: `#${(app.viewport.scene.background as { getHexString(): string }).getHexString()}`,
    }),
    escape: () => menu.escape,
  };
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(hooks));
}
