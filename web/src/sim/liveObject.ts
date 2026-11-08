// The object in the slot as the live physics has it now: pose, centre of mass, world points
// (mesh vertices and box corners) and which jaw bodies touch it. Read only: nothing here moves
// the live scene. Every call reads MuJoCo's arrays afresh, because WASM memory can grow and a
// spawn swaps the model.

import { JAW_BODIES } from '../control/pickCheck';
import { FIXED_PAD_SITE, MOVING_PAD_SITE } from './armXml';
import type { Mujoco } from './mujocoRuntime';
import { freeJointOf, worldPointsOfBody } from './objectSlot';
import { ARM_JOINTS, Simulation, type Vec3 } from './simulation';

export interface LiveObject {
  body: string;
  com: Vec3;
  /** Free joint origin, world metres. */
  position: Vec3;
  /** w, x, y, z. */
  quat: [number, number, number, number];
  points: Float64Array;
  /** Lowest point above the floor, m. */
  lowest: number;
  height: number;
}

/** The body in the slot: the arena cube at first, slot_<kind> after a spawn. Null when there is none. */
export function slotBodyName(mujoco: Mujoco, sim: Simulation): string | null {
  const model = sim.model;
  let cube: string | null = null;
  for (let b = 0; b < model.nbody; b++) {
    const name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY.value, b) ?? '';
    if (name.startsWith('slot_')) return name;
    if (name === 'cube') cube = name;
  }
  return cube;
}

export function liveObject(mujoco: Mujoco, sim: Simulation, bodyName: string): LiveObject {
  const { body, qadr } = freeJointOf(mujoco, sim, bodyName);
  const data = sim.mjData;
  const xipos = data.xipos as Float64Array;
  const qpos = data.qpos as Float64Array;
  const points = worldPointsOfBody(mujoco, sim, bodyName);
  let lowest = Infinity;
  let highest = -Infinity;
  for (let i = 2; i < points.length; i += 3) {
    lowest = Math.min(lowest, points[i]!);
    highest = Math.max(highest, points[i]!);
  }
  return {
    body: bodyName,
    com: [xipos[3 * body]!, xipos[3 * body + 1]!, xipos[3 * body + 2]!],
    position: [qpos[qadr]!, qpos[qadr + 1]!, qpos[qadr + 2]!],
    quat: [qpos[qadr + 3]!, qpos[qadr + 4]!, qpos[qadr + 5]!, qpos[qadr + 6]!],
    points,
    lowest: Number.isFinite(lowest) ? lowest : 0,
    height: Number.isFinite(highest - lowest) ? highest - lowest : 0,
  };
}

/** Jaw bodies (Fixed_Jaw, Moving_Jaw) touching the body after the last step, sorted. */
export function jawContacts(sim: Simulation, bodyName: string): string[] {
  const jaws = JAW_BODIES as readonly string[];
  return [...new Set(sim.contactsOf(bodyName).flatMap((c) => [c.body1, c.body2]).filter((name) => jaws.includes(name)))].sort();
}

/** True when the body touches the floor. */
export function touchesFloor(sim: Simulation, bodyName: string): boolean {
  return sim.contactsOf(bodyName).some((c) => c.body1 === 'world' || c.body2 === 'world' || /floor/i.test(c.geom1) || /floor/i.test(c.geom2));
}

/**
 * The jaw angle that leaves `gap` between the tip pads, found on a scratch MjData of the same
 * model, so the live qpos is never touched. Bisection on the pad sites, as the lift test does.
 */
export function jawAngleForGapScratch(mujoco: Mujoco, sim: Simulation, gap: number): number {
  const model = sim.model;
  const data = new mujoco.MjData(model);
  try {
    const qpos = data.qpos as Float64Array;
    qpos.set(sim.mjData.qpos as Float64Array);
    const jaw = ARM_JOINTS.length - 1;
    const [closed, open] = sim.jawRange();
    const fixedSite = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE.value, FIXED_PAD_SITE);
    const movingSite = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE.value, MOVING_PAD_SITE);
    const gapAt = (angle: number): number => {
      (data.qpos as Float64Array)[jaw] = angle;
      mujoco.mj_kinematics(model, data);
      const x = data.site_xpos as Float64Array;
      return Math.hypot(x[3 * fixedSite]! - x[3 * movingSite]!, x[3 * fixedSite + 1]! - x[3 * movingSite + 1]!, x[3 * fixedSite + 2]! - x[3 * movingSite + 2]!);
    };
    if (gap >= gapAt(open)) return open;
    if (gap <= gapAt(closed)) return closed;
    let lo = closed;
    let hi = open;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (gapAt(mid) < gap) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  } finally {
    data.delete();
  }
}
