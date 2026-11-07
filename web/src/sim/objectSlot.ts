// One object slot in the live scene. Spawning recompiles the scene XML with the object's
// MJCF fragment as the last body (in place of the previous occupant, at first the cube),
// carries the arm's state across, deletes the old model, and lets the object settle on the
// pad before anything plans a grasp.

import type { MjModel } from '@mujoco/mujoco';
import { ArmController } from '../control/armController';
import type { ControlLoop } from '../control/controlLoop';
import { ArmIk } from '../control/ik';
import { closingYawFor, graspSiteFor } from '../control/grasp';
import type { PickPlan } from '../input/pickScript';
import { GRIP_Z_MIN, ROLL_NOTE_MM, SETTLE_MAX_SECONDS } from '../objects/limits';
import { lines } from '../objects/messages';
import { toMjcf, type MjcfFragment } from '../objects/mjcf';
import type { Receipt, ReceiptStep, RestPose } from '../objects/receipt';
import { restPoseOf } from '../objects/settle';
import { GRIPPER_SITE, meshFilesIn } from './armXml';
import { ARM_XML, SCENE_XML, compileModel, type ModelFiles } from './compileModel';
import { applyGravityTo } from './gravity';
import type { Mujoco } from './mujocoRuntime';
import { ARM_JOINTS, Simulation, type Vec3 } from './simulation';

/** S2's verified pick location: the cube's pad, straight in front of the arm. */
export const PAD_XY: [number, number] = [0, -0.22];
/** Spawn height of the object's lowest point above the floor, in metres. */
export const SPAWN_DROP = 0.002;
/** The first occupant of the slot, from arena.xml. */
export const CUBE_SLOT_BODY = 'cube';
/** Gripper site to grip point: the grip point is at depth -0.092 in the Fixed_Jaw frame, the site at -0.0965 (armXml.ts). */
export const GRIP_POINT_ABOVE_SITE = 0.0045;
/** S2's pick script constants (input/pickScript.ts), repeated so a pick plan can be aimed at a grip height. */
const S2_GRASP_HEIGHT_ABOVE_CENTER = 0.007;

const SETTLE_WINDOW_STEPS = 25;
const STILL_SPEED = 0.002;
const STILL_TURN = (3 * Math.PI) / 180;

export interface SpawnReport {
  bodyName: string;
  compile_ms: number;
  /** Compile plus state copy, new controller and deletes. */
  swap_ms: number;
  settle_ms: number;
  settle_sim_s: number;
  settled: boolean;
  rolled_mm: number;
  rotated_deg: number;
  rest: RestPose;
  settleStep: ReceiptStep;
  /** MuJoCo's own collision hull, read back from the compiled model. */
  collisionHull: { vertices: number; volume_cm3: number } | null;
  hullStep: ReceiptStep | null;
}

/** Fetches the scene files once, so later spawns can recompile without the network. */
export async function fetchModelFiles(baseUrl: string = `${import.meta.env.BASE_URL}models/so_arm100/`): Promise<ModelFiles> {
  const get = async (path: string): Promise<Response> => {
    const response = await fetch(baseUrl + path);
    if (!response.ok) throw new Error(`could not fetch ${path}: HTTP ${response.status}`);
    return response;
  };
  const [armXml, sceneXml] = await Promise.all([get(ARM_XML).then((r) => r.text()), get(SCENE_XML).then((r) => r.text())]);
  const paths = meshFilesIn(armXml).map((file) => `assets/${file}`);
  const bytes = await Promise.all(paths.map(async (path) => new Uint8Array(await (await get(path)).arrayBuffer())));
  return { armXml, sceneXml, meshes: new Map(paths.map((path, i) => [path, bytes[i]!])) };
}

/** The scene XML with the cube taken out and the object added as the last body. */
export function sceneWithObject(sceneXml: string, fragment: MjcfFragment): string {
  const cube = /\s*<body name="cube"[\s\S]*?<\/body>/;
  if (!cube.test(sceneXml)) throw new Error('scene XML has no cube body to replace');
  if (!sceneXml.includes('</worldbody>')) throw new Error('scene XML has no worldbody');
  return sceneXml
    .replace(cube, '')
    .replace('<worldbody>', `<asset>${fragment.asset}</asset>\n  <worldbody>`)
    .replace('</worldbody>', `  ${fragment.body}\n  </worldbody>`);
}

/** Quaternion w, x, y, z for a turn about world z. */
export function yawQuat(radians: number): [number, number, number, number] {
  return [Math.cos(radians / 2), 0, 0, Math.sin(radians / 2)];
}

function quatMul(a: readonly number[], b: readonly number[]): [number, number, number, number] {
  const [aw, ax, ay, az] = a as [number, number, number, number];
  const [bw, bx, by, bz] = b as [number, number, number, number];
  return [aw * bw - ax * bx - ay * by - az * bz, aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw];
}

/**
 * MuJoCo's collision hull of one mesh, from mesh_graph: [numvert, numface, vert_edgeadr,
 * vert_globalid, edge_localid (numvert + 3 numface), face_globalid (3 numface)].
 */
export function collisionHullOf(mujoco: Mujoco, model: MjModel, meshName: string): { vertices: number; volume_cm3: number } | null {
  const mesh = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_MESH.value, meshName);
  if (mesh < 0) return null;
  const adr = (model.mesh_graphadr as Int32Array)[mesh]!;
  if (adr < 0) return null;
  const graph = model.mesh_graph as Int32Array;
  const numvert = graph[adr]!;
  const numface = graph[adr + 1]!;
  const faceStart = adr + 2 + numvert + numvert + (numvert + 3 * numface);
  const vertStart = (model.mesh_vertadr as Int32Array)[mesh]!;
  const vert = model.mesh_vert as Float32Array;
  const point = (local: number): [number, number, number] => {
    const i = 3 * (vertStart + local);
    return [vert[i]!, vert[i + 1]!, vert[i + 2]!];
  };
  let volume = 0;
  for (let f = 0; f < numface; f++) {
    const a = point(graph[faceStart + 3 * f]!);
    const b = point(graph[faceStart + 3 * f + 1]!);
    const c = point(graph[faceStart + 3 * f + 2]!);
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return { vertices: numvert, volume_cm3: Math.abs(volume) * 1e6 };
}

/** Writes a readonly field. ControlLoop's sim and controller are swapped in place so every holder of the loop sees the new model. */
function rebind<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): void {
  (target as { [P in K]: T[K] })[key] = value;
}

export class ObjectSlot {
  /** The body now in the slot. */
  bodyName: string = CUBE_SLOT_BODY;
  receipt: Receipt | null = null;
  /** The world heading the S2 controller gives the jaw at the pad: the object is turned to meet it. */
  readonly padHeading = closingYawFor([PAD_XY[0], PAD_XY[1], 0]);
  private ik: ArmIk | null = null;

  private filesCache: ModelFiles | null = null;

  /**
   * files: the scene to recompile, normally physicsOnlyFiles(...) so a spawn compiles in about
   * 0.1 s instead of seconds. A function is called once, at the first spawn, so page start stays fast.
   */
  constructor(
    private readonly mujoco: Mujoco,
    private readonly source: ModelFiles | (() => ModelFiles),
    private readonly loop: ControlLoop,
  ) {}

  private get files(): ModelFiles {
    this.filesCache ??= typeof this.source === 'function' ? this.source() : this.source;
    return this.filesCache;
  }

  get sim(): Simulation {
    return this.loop.sim;
  }

  /** Recompiles the scene with this object in the slot, swaps it into the live loop, and settles it on the pad. */
  spawn(receipt: Receipt): SpawnReport {
    if (!receipt.hull || receipt.mass_kg === null) throw new Error('this receipt has no sized object to spawn');
    const t0 = performance.now();
    // Turn the narrowest side to face the jaw's closing axis at the pad.
    const turn = this.padHeading - ((receipt.yaw_deg ?? 0) * Math.PI) / 180;
    const fragment = toMjcf(receipt, { name: `slot_${receipt.spec.kind}`, pos: [PAD_XY[0], PAD_XY[1], SPAWN_DROP], quat: yawQuat(turn) });
    const tc = performance.now();
    const model = compileModel(this.mujoco, { ...this.files, sceneXml: sceneWithObject(this.files.sceneXml, fragment) });
    const compileMs = performance.now() - tc;
    this.swapIn(model);
    this.bodyName = fragment.names.body;
    this.receipt = receipt;
    const swapMs = performance.now() - t0;

    const collisionHull = collisionHullOf(this.mujoco, model, fragment.names.mesh);
    let hullStep: ReceiptStep | null = null;
    const hullOk = receipt.steps.find((s) => s.code === 'HULL_OK');
    if (collisionHull && hullOk && receipt.hull_volume_cm3 !== null) {
      hullStep = { ...hullOk, message: lines.hullMeasured(receipt.hull_volume_cm3, receipt.hull.points.length / 3, collisionHull.volume_cm3, collisionHull.vertices) };
    }

    const settle = this.settle(receipt);
    return { bodyName: this.bodyName, compile_ms: compileMs, swap_ms: swapMs, collisionHull, hullStep, ...settle };
  }

  /** Puts the original scene back, with the cube in the slot. */
  restoreCube(): void {
    this.swapIn(compileModel(this.mujoco, this.files));
    this.bodyName = CUBE_SLOT_BODY;
    this.receipt = null;
  }

  /** Turns the resting object about the vertical through its centre of mass, as if the jaw met it at another yaw. */
  turnObject(radians: number): void {
    turnBodyAboutCom(this.mujoco, this.sim, this.bodyName, radians);
  }

  /**
   * S2's pick plan, aimed at the settled object: PickScript puts the gripper site 7 mm above
   * objectCenter and the fixed pad 3 mm past objectCenter + objectHalfWidth along the jaw axis.
   * So objectCenter is the middle of the object's extent along that axis at its centre of
   * mass, at a height that puts the grip point at the lift test's grip height.
   */
  pickPlan(): PickPlan {
    const sim = this.sim;
    const geom = worldPointsOfBody(this.mujoco, sim, this.bodyName);
    const com = sim.mjData.xipos as Float64Array;
    const body = this.freeJoint(sim, this.bodyName).body;
    const heading = closingYawFor([com[3 * body]!, com[3 * body + 1]!, 0]);
    const frame = alongJaw(geom, heading, [com[3 * body]!, com[3 * body + 1]!]);
    const gripZ = Math.max(frame.height / 2, GRIP_Z_MIN) + frame.lowest;
    const siteZ = gripZ - GRIP_POINT_ABOVE_SITE;
    const start = sim.getSitePos(GRIPPER_SITE);
    if (!start) throw new Error('model has no gripper site');
    return { objectCenter: [frame.center[0], frame.center[1], siteZ - S2_GRASP_HEIGHT_ABOVE_CENTER], objectHalfWidth: frame.halfWidth, start };
  }

  private settle(receipt: Receipt): Omit<SpawnReport, 'bodyName' | 'compile_ms' | 'swap_ms' | 'collisionHull' | 'hullStep'> {
    const t0 = performance.now();
    const sim = this.sim;
    const { qadr, body } = this.freeJoint(sim, this.bodyName);
    const data = sim.mjData;
    // Views are re-read after stepping: WASM memory can grow and detach an old one.
    const qposNow = (): Float64Array => data.qpos as Float64Array;
    const xiposNow = (): Float64Array => data.xipos as Float64Array;
    const startCom = [xiposNow()[3 * body]!, xiposNow()[3 * body + 1]!];
    const startQuat = Array.from(qposNow().subarray(qadr + 3, qadr + 7));
    const maxSteps = Math.round(SETTLE_MAX_SECONDS / sim.timestep);
    let steps = 0;
    let settled = false;
    let lastPos = Array.from(qposNow().subarray(qadr, qadr + 3));
    let lastQuat = startQuat;
    while (steps < maxSteps) {
      sim.step(SETTLE_WINDOW_STEPS);
      steps += SETTLE_WINDOW_STEPS;
      const pos = Array.from(qposNow().subarray(qadr, qadr + 3));
      const quat = Array.from(qposNow().subarray(qadr + 3, qadr + 7));
      const span = SETTLE_WINDOW_STEPS * sim.timestep;
      const speed = Math.hypot(pos[0]! - lastPos[0]!, pos[1]! - lastPos[1]!, pos[2]! - lastPos[2]!) / span;
      const turn = (2 * Math.acos(Math.min(1, Math.abs(quatDot(quat, lastQuat))))) / span;
      lastPos = pos;
      lastQuat = quat;
      const touching = sim.contactsOf(this.bodyName).length > 0;
      if (touching && speed < STILL_SPEED && turn < STILL_TURN) {
        settled = true;
        break;
      }
    }
    const position = Array.from(qposNow().subarray(qadr, qadr + 3));
    const quat = Array.from(qposNow().subarray(qadr + 3, qadr + 7));
    const xipos = xiposNow();
    const rolledMm = Math.hypot(xipos[3 * body]! - startCom[0]!, xipos[3 * body + 1]! - startCom[1]!) * 1000;
    const rotatedDeg = (2 * Math.acos(Math.min(1, Math.abs(quatDot(quat, startQuat)))) * 180) / Math.PI;
    const seconds = steps * sim.timestep;
    const gravity = Math.abs((sim.model.opt.gravity as Float64Array)[2]!);
    let settleStep: ReceiptStep;
    if (!settled) {
      settleStep = { code: 'SETTLE_TIMEOUT', ok: false, measured: seconds, limit: SETTLE_MAX_SECONDS, unit: 's', message: lines.settleTimeout(seconds, sim.contactsOf(this.bodyName).length > 0, gravity), action: 'note' };
    } else if (rolledMm > ROLL_NOTE_MM) {
      settleStep = { code: 'ROLLS', ok: true, measured: rolledMm, limit: ROLL_NOTE_MM, unit: 'mm', message: lines.rolls(rolledMm, rotatedDeg), action: 'note' };
    } else {
      settleStep = { code: 'SETTLED', ok: true, measured: rolledMm, limit: ROLL_NOTE_MM, unit: 'mm', message: lines.settled(rolledMm, rotatedDeg), action: 'note' };
    }
    return {
      settle_ms: performance.now() - t0,
      settle_sim_s: seconds,
      settled,
      rolled_mm: rolledMm,
      rotated_deg: rotatedDeg,
      rest: restPoseOf(receipt, position, quat, 'arena'),
      settleStep,
    };
  }

  /** New Simulation, IK and controller on the new model; the arm's qpos, qvel, ctrl and the clock carry over. */
  private swapIn(model: MjModel): void {
    const old = this.loop.sim;
    const oldController = this.loop.controller;
    const before = old.mjData;
    // A fresh model has MuJoCo's default gravity; it gets the page's current one before it steps.
    applyGravityTo(model);
    const next = new Simulation(this.mujoco, model);
    const after = next.mjData;
    const arm = ARM_JOINTS.length;
    (after.qpos as Float64Array).set((before.qpos as Float64Array).subarray(0, arm));
    (after.qvel as Float64Array).set((before.qvel as Float64Array).subarray(0, arm));
    (after.ctrl as Float64Array).set(before.ctrl as Float64Array);
    after.time = before.time;
    next.physicsSteps = old.physicsSteps;
    this.mujoco.mj_forward(model, after);

    const ik = new ArmIk(this.mujoco, model, GRIPPER_SITE);
    const controller = new ArmController(next, ik);
    const status = oldController.status();
    if (status.target) controller.setTarget(status.target);
    if (status.grip !== null) controller.setGrip(status.grip);
    controller.useGravityFeedforward = oldController.useGravityFeedforward;

    rebind(this.loop, 'sim', next);
    rebind(this.loop, 'controller', controller);

    // The first controller's IK was made in main.ts; ArmController keeps it private.
    const oldIk = this.ik ?? (oldController as unknown as { ik?: ArmIk }).ik ?? null;
    this.ik = ik;
    oldIk?.dispose();
    const oldModel = old.model;
    before.delete();
    oldModel.delete();
  }

  private freeJoint(sim: Simulation, bodyName: string): FreeJoint {
    return freeJointOf(this.mujoco, sim, bodyName);
  }
}

export interface FreeJoint {
  body: number;
  qadr: number;
  dadr: number;
}

export function freeJointOf(mujoco: Mujoco, sim: Simulation, bodyName: string): FreeJoint {
  const body = mujoco.mj_name2id(sim.model, mujoco.mjtObj.mjOBJ_BODY.value, bodyName);
  if (body < 0) throw new Error(`model has no body named ${bodyName}`);
  const joint = (sim.model.body_jntadr as Int32Array)[body]!;
  if (joint < 0) throw new Error(`body ${bodyName} has no joint`);
  return { body, qadr: (sim.model.jnt_qposadr as Int32Array)[joint]!, dadr: (sim.model.jnt_dofadr as Int32Array)[joint]! };
}

/** Turns a free body about the vertical line through its centre of mass, at rest, and updates kinematics. */
export function turnBodyAboutCom(mujoco: Mujoco, sim: Simulation, bodyName: string, radians: number): void {
  const { qadr, dadr, body } = freeJointOf(mujoco, sim, bodyName);
  const data = sim.mjData;
  const qpos = data.qpos as Float64Array;
  const xipos = data.xipos as Float64Array;
  const cx = xipos[3 * body]!;
  const cy = xipos[3 * body + 1]!;
  const dx = qpos[qadr]! - cx;
  const dy = qpos[qadr + 1]! - cy;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  qpos[qadr] = cx + c * dx - s * dy;
  qpos[qadr + 1] = cy + s * dx + c * dy;
  qpos.set(quatMul(yawQuat(radians), Array.from(qpos.subarray(qadr + 3, qadr + 7))), qadr + 3);
  (data.qvel as Float64Array).fill(0, dadr, dadr + 6);
  mujoco.mj_forward(sim.model, data);
}

function quatDot(a: readonly number[], b: readonly number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!;
}

/** Every vertex of the body's mesh geoms in world coordinates, from MuJoCo's own state. */
export function worldPointsOfBody(mujoco: Mujoco, sim: Simulation, bodyName: string): Float64Array {
  const model = sim.model;
  const data = sim.mjData;
  const body = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, bodyName);
  const geomBody = model.geom_bodyid as Int32Array;
  const geomType = model.geom_type as Int32Array;
  const geomMesh = model.geom_dataid as Int32Array;
  const xpos = data.geom_xpos as Float64Array;
  const xmat = data.geom_xmat as Float64Array;
  const vert = model.mesh_vert as Float32Array;
  const out: number[] = [];
  for (let g = 0; g < model.ngeom; g++) {
    if (geomBody[g] !== body || geomType[g] !== mujoco.mjtGeom.mjGEOM_MESH.value) continue;
    const mesh = geomMesh[g]!;
    const start = (model.mesh_vertadr as Int32Array)[mesh]!;
    const count = (model.mesh_vertnum as Int32Array)[mesh]!;
    const p = [xpos[3 * g]!, xpos[3 * g + 1]!, xpos[3 * g + 2]!];
    const m = Array.from(xmat.subarray(9 * g, 9 * g + 9));
    for (let v = start; v < start + count; v++) {
      const x = vert[3 * v]!;
      const y = vert[3 * v + 1]!;
      const z = vert[3 * v + 2]!;
      out.push(p[0]! + m[0]! * x + m[1]! * y + m[2]! * z, p[1]! + m[3]! * x + m[4]! * y + m[5]! * z, p[2]! + m[6]! * x + m[7]! * y + m[8]! * z);
    }
  }
  return Float64Array.from(out);
}

export interface JawFrame {
  /** Middle of the extent along the jaw axis, at the centre of mass across it. World x, y. */
  center: [number, number];
  halfWidth: number;
  lowest: number;
  height: number;
}

/** The object's extent along the jaw closing axis at a heading, and its height. */
export function alongJaw(points: ArrayLike<number>, heading: number, com: [number, number]): JawFrame {
  const ux = Math.cos(heading);
  const uy = Math.sin(heading);
  let low = Infinity;
  let high = -Infinity;
  let zLow = Infinity;
  let zHigh = -Infinity;
  for (let i = 0; i + 2 < points.length; i += 3) {
    const d = points[i]! * ux + points[i + 1]! * uy;
    low = Math.min(low, d);
    high = Math.max(high, d);
    zLow = Math.min(zLow, points[i + 2]!);
    zHigh = Math.max(zHigh, points[i + 2]!);
  }
  const mid = (low + high) / 2;
  const across = -com[0] * uy + com[1] * ux;
  return { center: [mid * ux - across * uy, mid * uy + across * ux], halfWidth: (high - low) / 2, lowest: zLow, height: zHigh - zLow };
}

/** Where S2's grasp puts the gripper site for a jaw frame, for checks and the lift tester. */
export function graspSiteForFrame(frame: JawFrame, siteZ: number, clearance: number): Vec3 {
  return graspSiteFor([frame.center[0], frame.center[1], siteZ], frame.halfWidth, clearance, 0);
}
