import { GRIPPER_SITE } from '../sim/armXml';
import type { Simulation } from '../sim/simulation';
import type { PickPlan } from './pickScript';

export const CUBE_BODY = 'cube';
export const CUBE_GEOM = 'cube_geom';

/** The pick plan for the cube where it rests now, from the gripper's current position. */
export function cubePickPlan(sim: Simulation): PickPlan {
  const center = sim.getBodyPos(CUBE_BODY);
  const start = sim.getSitePos(GRIPPER_SITE);
  if (!center || !start) throw new Error('scene has no cube or no gripper site');
  return { objectCenter: center, objectHalfWidth: sim.geomHalfSize(CUBE_GEOM)[0], start };
}
