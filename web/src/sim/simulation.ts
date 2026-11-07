import type { MjData, MjModel } from '@mujoco/mujoco';
import { FIXED_PAD_SITE, MOVING_PAD_SITE } from './armXml';
import type { Mujoco } from './mujocoRuntime';

export type Vec3 = [number, number, number];

/** Actuator order in so_arm100.xml. The jaw is the last one. */
export const ARM_JOINTS = ['Rotation', 'Pitch', 'Elbow', 'Wrist_Pitch', 'Wrist_Roll', 'Jaw'] as const;
export const JAW_ACTUATOR = ARM_JOINTS.length - 1;
const START_KEYFRAME = 'home';

export interface ContactReport {
  body1: string;
  body2: string;
  geom1: string;
  geom2: string;
  /** Signed distance in metres. Negative is penetration. */
  dist: number;
}

export class Simulation {
  readonly timestep: number;
  physicsSteps = 0;
  private readonly data: MjData;
  private readonly bodyIds = new Map<string, number>();
  private readonly siteIds = new Map<string, number>();
  private readonly keyframe: number;

  constructor(
    private readonly mujoco: Mujoco,
    readonly model: MjModel,
  ) {
    this.data = new mujoco.MjData(model);
    this.timestep = model.opt.timestep;
    this.keyframe = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_KEY.value, START_KEYFRAME);
    if (this.keyframe < 0) throw new Error(`model has no keyframe named ${START_KEYFRAME}`);
    this.reset();
  }

  get time(): number {
    return this.data.time;
  }

  /** The live MjData, for the object slot, which copies the arm's state into a recompiled model and deletes the old one. */
  get mjData(): MjData {
    return this.data;
  }

  /** Back to the start keyframe: arm at home, cube at its rest pose, time zero. */
  reset(): void {
    this.mujoco.mj_resetDataKeyframe(this.model, this.data, this.keyframe);
    this.mujoco.mj_forward(this.model, this.data);
  }

  /** Moves a free-joint body to a position, upright and at rest, and updates kinematics. */
  placeFreeBody(name: string, position: Vec3): void {
    const body = this.bodyId(name);
    if (body < 0) throw new Error(`model has no body named ${name}`);
    const joint = (this.model.body_jntadr as Int32Array)[body]!;
    if (joint < 0 || (this.model.jnt_type as Int32Array)[joint] !== this.mujoco.mjtJoint.mjJNT_FREE.value) {
      throw new Error(`body ${name} has no free joint`);
    }
    const qpos = this.data.qpos as Float64Array;
    const qvel = this.data.qvel as Float64Array;
    const qadr = (this.model.jnt_qposadr as Int32Array)[joint]!;
    const dadr = (this.model.jnt_dofadr as Int32Array)[joint]!;
    qpos.set([...position, 1, 0, 0, 0], qadr);
    qvel.fill(0, dadr, dadr + 6);
    this.mujoco.mj_forward(this.model, this.data);
  }

  step(count: number): void {
    for (let i = 0; i < count; i++) this.mujoco.mj_step(this.model, this.data);
    this.physicsSteps += count;
  }

  /** Live poses in world coordinates, 3 and 4 values per body. Re-read after every step. */
  bodyPoses(): { xpos: Float64Array; xquat: Float64Array } {
    return { xpos: this.data.xpos, xquat: this.data.xquat };
  }

  getBodyPos(name: string): Vec3 | null {
    const id = this.bodyId(name);
    return id < 0 ? null : readVec3(this.data.xpos, id);
  }

  getSitePos(name: string): Vec3 | null {
    const id = this.lookup(this.siteIds, this.mujoco.mjtObj.mjOBJ_SITE.value, name);
    return id < 0 ? null : readVec3(this.data.site_xpos, id);
  }

  /** The arm joints in ARM_JOINTS order. They come first in qpos, before the cube. */
  getJointPos(): number[] {
    return Array.from((this.data.qpos as Float64Array).subarray(0, ARM_JOINTS.length));
  }

  /**
   * Generalized force the actuators must supply to hold the arm still against gravity and
   * velocity effects, per arm joint (qfrc_bias, from the last step). Includes a held load.
   */
  getArmBiasForces(): number[] {
    return Array.from((this.data.qfrc_bias as Float64Array).subarray(0, ARM_JOINTS.length));
  }

  /** Position commands for the arm actuators before the jaw, each limited to its control range. */
  setArmCtrl(radians: readonly number[]): void {
    const ctrl = this.data.ctrl as Float64Array;
    const range = this.model.actuator_ctrlrange as Float64Array;
    radians.forEach((value, i) => {
      if (i >= JAW_ACTUATOR) return;
      ctrl[i] = Math.min(range[2 * i + 1]!, Math.max(range[2 * i]!, value));
    });
  }

  getCtrl(): number[] {
    return Array.from(this.data.ctrl as Float64Array);
  }

  /** Jaw position command in radians, limited to the actuator's control range. */
  setJawCtrl(radians: number): void {
    const [closed, open] = this.jawRange();
    (this.data.ctrl as Float64Array)[JAW_ACTUATOR] = Math.min(open, Math.max(closed, radians));
  }

  /** [closed, open] in radians. */
  jawRange(): [number, number] {
    const range = this.model.actuator_ctrlrange as Float64Array;
    return [range[2 * JAW_ACTUATOR]!, range[2 * JAW_ACTUATOR + 1]!];
  }

  /** Clear gap between the inner faces of the jaw tips, in metres. */
  gripperOpening(): number {
    const fixed = this.getSitePos(FIXED_PAD_SITE);
    const moving = this.getSitePos(MOVING_PAD_SITE);
    if (!fixed || !moving) throw new Error('jaw tip sites are missing from the model');
    return Math.hypot(fixed[0] - moving[0], fixed[1] - moving[1], fixed[2] - moving[2]);
  }

  /** Contacts from the last step that involve the named body. */
  contactsOf(bodyName: string): ContactReport[] {
    const id = this.bodyId(bodyName);
    if (id < 0) return [];
    const geomBody = this.model.geom_bodyid as Int32Array;
    const contacts = this.data.contact;
    const found: ContactReport[] = [];
    try {
      const count = Math.min(this.data.ncon, contacts.size());
      for (let i = 0; i < count; i++) {
        const contact = contacts.get(i);
        if (!contact) continue;
        const body1 = geomBody[contact.geom1]!;
        const body2 = geomBody[contact.geom2]!;
        if (body1 === id || body2 === id) {
          found.push({
            body1: this.name(this.mujoco.mjtObj.mjOBJ_BODY.value, body1),
            body2: this.name(this.mujoco.mjtObj.mjOBJ_BODY.value, body2),
            geom1: this.name(this.mujoco.mjtObj.mjOBJ_GEOM.value, contact.geom1),
            geom2: this.name(this.mujoco.mjtObj.mjOBJ_GEOM.value, contact.geom2),
            dist: contact.dist,
          });
        }
        contact.delete();
      }
    } finally {
      contacts.delete();
    }
    return found;
  }

  /** A geom's size parameters from the model (half extents for a box). */
  geomHalfSize(name: string): Vec3 {
    const id = this.mujoco.mj_name2id(this.model, this.mujoco.mjtObj.mjOBJ_GEOM.value, name);
    if (id < 0) throw new Error(`model has no geom named ${name}`);
    return readVec3(this.model.geom_size as Float64Array, id);
  }

  private name(objectType: number, id: number): string {
    return this.mujoco.mj_id2name(this.model, objectType, id) || `#${id}`;
  }

  private bodyId(name: string): number {
    return this.lookup(this.bodyIds, this.mujoco.mjtObj.mjOBJ_BODY.value, name);
  }

  private lookup(cache: Map<string, number>, objectType: number, name: string): number {
    let id = cache.get(name);
    if (id === undefined) {
      id = this.mujoco.mj_name2id(this.model, objectType, name);
      cache.set(name, id);
    }
    return id;
  }
}

function readVec3(array: Float64Array, index: number): Vec3 {
  return [array[3 * index]!, array[3 * index + 1]!, array[3 * index + 2]!];
}
