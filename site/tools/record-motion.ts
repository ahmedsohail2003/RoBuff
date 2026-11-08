// Records the motion clip for the project page's point-cloud animation: the simulated
// SO-ARM100 picking and lifting the generated Bennu-like sample, from the app's own code.
//
// Run from web/:  node scripts/run-ts.mjs ../site/tools/record-motion.ts
//
// What it does, in the same order as the app's Node test (web/src/sim/liftTester.test.ts,
// "Bennu-like sample: spawned, settled on the pad, and lifted by the headless arm test"):
//   1. compiles the physics-only arm (physicsOnlyFiles), validates the bennu-sample preset,
//      spawns it in the object slot and lets it settle on the pad;
//   2. runs the app's ArmLiftTester through proveLift, unchanged. The only addition is a
//      wrapper around Simulation.prototype.step that steps one physics step at a time (what
//      step(n) does anyway) and, on the tester's own MjData, samples every body's world pose
//      each 1/30 s of simulated time, plus the last grip command given to ArmController.
//   3. keeps the passing attempt, trims it to about 1 s before the jaw starts closing through
//      the end of the hold, and writes site/assets/motion/pick.json.
// Body points come from the full model's visual meshes (mesh_vert via geom_dataid, moved from
// geom frame into body frame with geom_pos/geom_quat); the rock's from its generated mesh.
// Nothing under web/ is written.

import { execSync } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { MjModel } from '@mujoco/mujoco';
import { ArmController } from '../../web/src/control/armController';
import { ControlLoop } from '../../web/src/control/controlLoop';
import { ArmIk } from '../../web/src/control/ik';
import { validate } from '../../web/src/objects/guardrail';
import { proveLift, type LiftRequest } from '../../web/src/objects/lift';
import { LIFT_HEIGHT, LIFT_PASS_RISE } from '../../web/src/objects/limits';
import { PRESETS } from '../../web/src/objects/mock';
import { withSettleStep } from '../../web/src/objects/settle';
import type { Receipt } from '../../web/src/objects/receipt';
import { GRIPPER_SITE, meshFilesIn } from '../../web/src/sim/armXml';
import { ARM_XML, SCENE_XML, compileModel } from '../../web/src/sim/compileModel';
import { ArmLiftTester, liftPhases, scoreLift, type LiftSample } from '../../web/src/sim/liftTester';
import { loadNode } from '../../web/src/sim/loadModelNode';
import type { Mujoco } from '../../web/src/sim/mujocoRuntime';
import { ObjectSlot } from '../../web/src/sim/objectSlot';
import { physicsOnlyFiles } from '../../web/src/sim/physicsScene';
import { Simulation } from '../../web/src/sim/simulation';
import { readFileSync } from 'node:fs';

const HERE = import.meta.dirname;
const REPO = path.resolve(HERE, '../..');
const WEB = path.join(REPO, 'web');
const MODEL_DIR = path.join(WEB, 'public/models/so_arm100');
const OUT_DIR = path.join(REPO, 'site/assets/motion');
const OUT = path.join(OUT_DIR, 'pick.json');

const PRESET_ID = 'bennu-sample';
const FPS = 30;
/** Seconds of approach kept before the jaw starts closing. */
const LEAD_S = 1.0;
const POINTS_MIN = 150;
const POINTS_MAX = 500;
const POINTS_TOTAL_MAX = 6000;
const ROCK_POINTS = 450;
const ARM_POINTS_TOTAL = 3200;
const SIZE_LIMIT = 1.5 * 1024 * 1024;

type V3 = [number, number, number];
type Q4 = [number, number, number, number];

function rotate(q: readonly number[], v: readonly number[]): V3 {
  const [w, x, y, z] = q as Q4;
  const [vx, vy, vz] = v as V3;
  // v + 2 w (u x v) + 2 u x (u x v), u = (x, y, z)
  const cx = y * vz - z * vy;
  const cy = z * vx - x * vz;
  const cz = x * vy - y * vx;
  return [vx + 2 * (w * cx + y * cz - z * cy), vy + 2 * (w * cy + z * cx - x * cz), vz + 2 * (w * cz + x * cy - y * cx)];
}

/** Farthest-point subsample: an even spread over the vertices, deterministic (starts at the first). */
function farthestPoints(points: V3[], count: number): V3[] {
  if (points.length <= count) return points.slice();
  const chosen: V3[] = [];
  const best = new Float64Array(points.length).fill(Infinity);
  let next = 0;
  for (let k = 0; k < count; k++) {
    const p = points[next]!;
    chosen.push(p);
    let far = -1;
    let farIndex = 0;
    for (let i = 0; i < points.length; i++) {
      const q = points[i]!;
      const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
      if (d < best[i]!) best[i] = d;
      if (best[i]! > far) {
        far = best[i]!;
        farIndex = i;
      }
    }
    next = farIndex;
  }
  return chosen;
}

function dedupe(points: V3[]): V3[] {
  const seen = new Set<string>();
  return points.filter((p) => {
    const key = p.map((v) => v.toFixed(5)).join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Vertices of a body's visual mesh geoms (contype 0 and conaffinity 0: what the app draws), in the body frame. */
function visualPointsOfBody(mujoco: Mujoco, model: MjModel, bodyName: string): V3[] {
  const body = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, bodyName);
  if (body < 0) throw new Error(`full model has no body ${bodyName}`);
  const geomBody = model.geom_bodyid as Int32Array;
  const geomType = model.geom_type as Int32Array;
  const geomData = model.geom_dataid as Int32Array;
  const contype = model.geom_contype as Int32Array;
  const conaff = model.geom_conaffinity as Int32Array;
  const gpos = model.geom_pos as Float64Array;
  const gquat = model.geom_quat as Float64Array;
  const vertAdr = model.mesh_vertadr as Int32Array;
  const vertNum = model.mesh_vertnum as Int32Array;
  const vert = model.mesh_vert as Float32Array;
  const out: V3[] = [];
  for (let g = 0; g < model.ngeom; g++) {
    if (geomBody[g] !== body || geomType[g] !== mujoco.mjtGeom.mjGEOM_MESH.value) continue;
    if (contype[g] !== 0 || conaff[g] !== 0) continue;
    const mesh = geomData[g]!;
    const p = [gpos[3 * g]!, gpos[3 * g + 1]!, gpos[3 * g + 2]!];
    const q = [gquat[4 * g]!, gquat[4 * g + 1]!, gquat[4 * g + 2]!, gquat[4 * g + 3]!];
    for (let v = vertAdr[mesh]!; v < vertAdr[mesh]! + vertNum[mesh]!; v++) {
      const r = rotate(q, [vert[3 * v]!, vert[3 * v + 1]!, vert[3 * v + 2]!]);
      out.push([p[0]! + r[0], p[1]! + r[1], p[2]! + r[2]]);
    }
  }
  return dedupe(out);
}

/** Vertices of a body's mesh geoms in the body frame, read from a compiled model (used to check the rock's frame). */
function meshPointsOfBody(mujoco: Mujoco, model: MjModel, bodyName: string): V3[] {
  const body = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, bodyName);
  const geomBody = model.geom_bodyid as Int32Array;
  const geomType = model.geom_type as Int32Array;
  const geomData = model.geom_dataid as Int32Array;
  const gpos = model.geom_pos as Float64Array;
  const gquat = model.geom_quat as Float64Array;
  const vertAdr = model.mesh_vertadr as Int32Array;
  const vertNum = model.mesh_vertnum as Int32Array;
  const vert = model.mesh_vert as Float32Array;
  const out: V3[] = [];
  for (let g = 0; g < model.ngeom; g++) {
    if (geomBody[g] !== body || geomType[g] !== mujoco.mjtGeom.mjGEOM_MESH.value) continue;
    const mesh = geomData[g]!;
    const p = [gpos[3 * g]!, gpos[3 * g + 1]!, gpos[3 * g + 2]!];
    const q = [gquat[4 * g]!, gquat[4 * g + 1]!, gquat[4 * g + 2]!, gquat[4 * g + 3]!];
    for (let v = vertAdr[mesh]!; v < vertAdr[mesh]! + vertNum[mesh]!; v++) {
      const r = rotate(q, [vert[3 * v]!, vert[3 * v + 1]!, vert[3 * v + 2]!]);
      out.push([p[0]! + r[0], p[1]! + r[1], p[2]! + r[2]]);
    }
  }
  return out;
}

function bboxDiag(points: V3[]): number {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let a = 0; a < 3; a++) {
    lo[a] = Math.min(lo[a]!, p[a]!);
    hi[a] = Math.max(hi[a]!, p[a]!);
  }
  return Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
}

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;
const r5 = (v: number): number => Math.round(v * 1e5) / 1e5;
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;

interface RawFrame {
  /** Seconds since the tester's first step. */
  t: number;
  /** Per body (arm bodies then rock): x, y, z, qw, qx, qy, qz. */
  poses: number[][];
  grip: number;
  rockComZ: number;
}

interface Recording {
  t0: number | null;
  next: number;
  frames: RawFrame[];
  sim: Simulation | null;
}

function git(args: string): string {
  try {
    return execSync(`git ${args}`, { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const commit = git('rev-parse --short HEAD');
  const dirty = git('status --porcelain -- web/src/sim web/src/objects web/src/control web/public/models');

  // Full model for drawing (visual meshes), as the app loads it.
  const { mujoco, model: fullModel } = await loadNode();

  // Physics-only files and the spawn, exactly as spawnAndProve in liftTester.test.ts.
  const read = (file: string) => readFileSync(path.join(MODEL_DIR, file));
  const armXml = read(ARM_XML).toString('utf8');
  const meshPaths = meshFilesIn(armXml).map((file) => `assets/${file}`);
  const files = physicsOnlyFiles({ armXml, sceneXml: read(SCENE_XML).toString('utf8'), meshes: new Map(meshPaths.map((p) => [p, new Uint8Array(read(p))])) });
  const model = compileModel(mujoco, files);
  const sim = new Simulation(mujoco, model);
  const loop = new ControlLoop(sim, new ArmController(sim, new ArmIk(mujoco, model, GRIPPER_SITE)));
  const slot = new ObjectSlot(mujoco, files, loop);
  const gravity = Math.abs((model.opt.gravity as Float64Array)[2]!);
  const preset = PRESETS.find((p) => p.id === PRESET_ID);
  if (!preset) throw new Error(`no preset ${PRESET_ID}`);
  let receipt: Receipt = validate(preset.spec, { gravity_m_s2: gravity });
  if (receipt.verdict !== 'READY_FOR_LIFT_TEST') throw new Error(`guardrail verdict ${receipt.verdict}`);
  const spawn = slot.spawn(receipt);
  receipt = withSettleStep(receipt, spawn.settleStep, spawn.rest);
  const live = slot.sim;
  const liveModel = live.model;
  const rockName = slot.bodyName;
  const nbody = liveModel.nbody;
  const bodyNames = Array.from({ length: nbody - 1 }, (_, i) => mujoco.mj_id2name(liveModel, mujoco.mjtObj.mjOBJ_BODY.value, i + 1));
  if (bodyNames.at(-1) !== rockName) throw new Error(`rock is not the last body: ${bodyNames.join(', ')}`);
  const rockId = nbody - 1;

  // Record the tester's own MjData. Simulation.step(n) is n calls of mj_step; this does the
  // same calls, one at a time, and samples poses between them. The live sim is never sampled.
  let recording: Recording | null = null;
  let lastGrip = Number.NaN;
  const stepProto = Simulation.prototype as unknown as { step: (this: Simulation, count: number) => void };
  const originalStep = stepProto.step;
  const sample = (s: Simulation, rec: Recording, t: number): void => {
    const data = s.mjData;
    const xpos = data.xpos as Float64Array;
    const xquat = data.xquat as Float64Array;
    const xipos = data.xipos as Float64Array;
    const poses: number[][] = [];
    for (let b = 1; b < nbody; b++) {
      poses.push([xpos[3 * b]!, xpos[3 * b + 1]!, xpos[3 * b + 2]!, xquat[4 * b]!, xquat[4 * b + 1]!, xquat[4 * b + 2]!, xquat[4 * b + 3]!]);
    }
    rec.frames.push({ t, poses, grip: lastGrip, rockComZ: xipos[3 * rockId + 2]! });
  };
  stepProto.step = function (this: Simulation, count: number): void {
    const rec = recording;
    if (!rec || this === slot.sim) {
      originalStep.call(this, count);
      return;
    }
    if (rec.sim !== this) {
      rec.sim = this;
      rec.t0 = this.mjData.time;
      rec.next = 1 / FPS;
      sample(this, rec, 0);
    }
    const dt = this.timestep;
    for (let i = 0; i < count; i++) {
      originalStep.call(this, 1);
      const t = this.mjData.time - rec.t0!;
      if (t >= rec.next - dt / 2) {
        sample(this, rec, t);
        rec.next += 1 / FPS;
      }
    }
  };
  const ctrlProto = ArmController.prototype as unknown as { setGrip: (this: ArmController, grip: number) => void };
  const originalSetGrip = ctrlProto.setGrip;
  ctrlProto.setGrip = function (this: ArmController, grip: number): void {
    lastGrip = grip;
    originalSetGrip.call(this, grip);
  };

  const tester = new ArmLiftTester(mujoco, { live: () => slot.sim, bodyName: rockName });
  const recordings: { request: LiftRequest; rec: Recording }[] = [];
  const realTest = tester.testLift.bind(tester);
  tester.testLift = async (request: LiftRequest) => {
    const rec: Recording = { t0: null, next: 0, frames: [], sim: null };
    recording = rec;
    try {
      return await realTest(request);
    } finally {
      recording = null;
      recordings.push({ request, rec });
    }
  };
  receipt = await proveLift(receipt, tester);
  stepProto.step = originalStep;
  ctrlProto.setGrip = originalSetGrip;

  if (receipt.verdict !== 'PASS') throw new Error(`lift verdict ${receipt.verdict}: ${receipt.lift.message}`);
  const attempt = receipt.lift.attempts.at(-1)!;
  const run = tester.runs.at(-1)!;
  const { rec } = recordings.at(-1)!;
  console.log(`receipt ${receipt.verdict}; attempts ${receipt.lift.attempts.length}; rise ${attempt.rise_mm.toFixed(2)} mm; hold ${attempt.hold_s?.toFixed(2)} s; ${rec.frames.length} raw frames over ${rec.frames.at(-1)!.t.toFixed(3)} s`);

  // Phase timing from the app's own timeline (durations do not depend on the waypoints).
  const phases = liftPhases([0, 0, 0], 0, LIFT_HEIGHT);
  const starts: Record<string, number> = {};
  let at = 0;
  for (const p of phases) {
    starts[p.name] = at;
    at += p.moveS + p.dwellS;
  }
  const liftMoveEnd = starts.lift! + phases.find((p) => p.name === 'lift')!.moveS;
  const clipStart = starts.close! - LEAD_S;
  const restComZ = rec.frames[0]!.rockComZ;

  const kept = rec.frames.filter((f) => f.t >= clipStart - 1e-6);
  const tOf = (f: RawFrame) => f.t - kept[0]!.t;

  // Rock points: the generated mesh (receipt.mesh), whose frame is the body frame. Check it
  // against the compiled model's own rock mesh, moved into the body frame the same way.
  if (!receipt.mesh) throw new Error('receipt has no mesh');
  const pos = receipt.mesh.positions;
  const rockAll: V3[] = [];
  for (let i = 0; i < pos.length; i += 3) rockAll.push([pos[i]!, pos[i + 1]!, pos[i + 2]!]);
  const rockCompiled = meshPointsOfBody(mujoco, liveModel, rockName);
  const ext = (pts: V3[], a: number) => [Math.min(...pts.map((p) => p[a]!)), Math.max(...pts.map((p) => p[a]!))];
  for (let a = 0; a < 3; a++) {
    const [ml, mh] = ext(rockAll, a);
    const [cl, ch] = ext(rockCompiled, a);
    if (Math.abs(ml! - cl!) > 1e-4 || Math.abs(mh! - ch!) > 1e-4) throw new Error(`rock mesh frame mismatch on axis ${a}: mesh ${ml}..${mh}, compiled ${cl}..${ch}`);
  }

  // Arm points: visual meshes of the full model, by the same body names.
  const armNames = bodyNames.slice(0, -1);
  const armAll = armNames.map((name) => visualPointsOfBody(mujoco, fullModel, name));
  const weights = armAll.map((pts) => bboxDiag(pts) ** 2);
  const weightSum = weights.reduce((s, w) => s + w, 0);
  const budgets = weights.map((w, i) => Math.min(armAll[i]!.length, Math.max(POINTS_MIN, Math.min(POINTS_MAX, Math.round((ARM_POINTS_TOTAL * w) / weightSum)))));
  const bodies = [
    ...armNames.map((name, i) => ({ name, points: farthestPoints(armAll[i]!, budgets[i]!).map((p) => p.map(r4) as V3) })),
    { name: rockName, points: farthestPoints(rockAll, ROCK_POINTS).map((p) => p.map(r4) as V3) },
  ];

  const frames = kept.map((f) => ({
    t: r4(tOf(f)),
    poses: f.poses.map((p) => [r5(p[0]!), r5(p[1]!), r5(p[2]!), r5(p[3]!), r5(p[4]!), r5(p[5]!), r5(p[6]!)]),
    grip: r4(f.grip),
  }));

  const rel = (t: number) => r4(t - kept[0]!.t);
  const events = [
    { t: 0, label: 'approach' },
    { t: rel(starts.close!), label: 'close' },
    { t: rel(starts.lift!), label: 'lift' },
    { t: rel(liftMoveEnd), label: 'lifted' },
    { t: rel(starts.hold!), label: 'hold' },
    { t: frames.at(-1)!.t, label: 'end' },
  ];

  // Measured from this recording: centre-of-mass rise at the end of the hold, and the longest
  // stretch with the grip closed and the rise at the pass line, scored by the app's scoreLift.
  const samples: LiftSample[] = kept.map((f) => ({ t: tOf(f), phase: 'hold', rise: f.rockComZ - restComZ, closed: f.grip >= 0.999 }));
  const score = scoreLift(samples, LIFT_PASS_RISE);

  // Lowest point of the rock (full generated mesh) per frame, from the recorded poses.
  const lowestAt = (f: RawFrame): number => {
    const p = f.poses.at(-1)!;
    let low = Infinity;
    for (const v of rockAll) low = Math.min(low, p[2]! + rotate(p.slice(3), v)[2]);
    return low;
  };
  const restLowest = lowestAt(rec.frames[0]!);
  const holdFrames = kept.filter((f) => f.t >= starts.hold! - 1e-6);
  const lowestRiseInHold = Math.min(...holdFrames.map((f) => lowestAt(f) - restLowest));
  const liftedFrames = kept.filter((f) => f.t >= liftMoveEnd - 1e-6);
  const lowestRiseAfterLift = Math.min(...liftedFrames.map((f) => lowestAt(f) - restLowest));

  const measured = {
    rock_width_mm: r4(receipt.size_mm![0]),
    rock_mass_g: r4(receipt.mass_kg! * 1000),
    rock_rise_mm: r4(score.rise * 1000),
    held_s: r4(score.holdS),
  };

  const out = {
    meta: {
      source:
        `site/tools/record-motion.ts at repo commit ${commit}: web/src/sim/liftTester.ts ArmLiftTester via proveLift, unchanged ` +
        `(Simulation.step wrapped to sample each physics step), on MuJoCo Menagerie trs_so_arm100 in web/public/models/so_arm100, ` +
        `object preset ${PRESET_ID} (seed ${preset.spec.seed}), spawned and settled by ObjectSlot at Earth gravity ${r4(gravity)} m/s2`,
      fps: FPS,
      frames: frames.length,
      units: 'm',
      up: 'z',
      quat: 'wxyz',
      timestep_s: live.timestep,
      clip_start_in_test_s: r4(kept[0]!.t),
      working_tree_changes_in_sim_objects_control: dirty === '' ? 'none' : dirty.split('\n'),
      receipt: {
        verdict: receipt.verdict,
        size_mm: receipt.size_mm!.map(r4),
        narrow_width_mm: receipt.narrow_width_mm === null ? null : r4(receipt.narrow_width_mm),
        mass_g: r4(receipt.mass_kg! * 1000),
        material: receipt.material.id,
        lift_attempts: receipt.lift.attempts.length,
        lift_rise_mm: r4(attempt.rise_mm),
        lift_hold_s: attempt.hold_s === undefined ? null : r4(attempt.hold_s),
        jaw_width_at_yaw_mm: r4(run.width_mm),
        jaw_opened_to_mm: r4(run.jaw_gap_mm),
        jaws_touching_at_end: run.jaws_touching,
      },
      checks: {
        rock_lowest_point_min_rise_in_hold_mm: r4(lowestRiseInHold * 1000),
        rock_lowest_point_min_rise_after_lift_move_mm: r4(lowestRiseAfterLift * 1000),
        pass_rise_mm: r4(LIFT_PASS_RISE * 1000),
      },
    },
    bodies,
    frames,
    events,
    measured,
  };

  // Validate before writing.
  const numbers: number[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'number') numbers.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(out);
  const bad = numbers.filter((n) => !Number.isFinite(n));
  if (bad.length) throw new Error(`${bad.length} non-finite numbers`);
  const totalPoints = bodies.reduce((s, b) => s + b.points.length, 0);
  if (totalPoints > POINTS_TOTAL_MAX) throw new Error(`too many points: ${totalPoints}`);
  if (frames.some((f) => f.poses.length !== bodies.length)) throw new Error('pose count does not match body count');
  if (!(lowestRiseInHold >= LIFT_PASS_RISE)) throw new Error(`rock's lowest point rose only ${(lowestRiseInHold * 1000).toFixed(2)} mm during the hold`);
  if (Math.abs(measured.rock_rise_mm - attempt.rise_mm) > 1) throw new Error(`recorded rise ${measured.rock_rise_mm} differs from the receipt's ${attempt.rise_mm}`);

  const json = JSON.stringify(out);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, json);
  const size = statSync(OUT).size;
  if (size >= SIZE_LIMIT) throw new Error(`pick.json is ${size} bytes, over the limit`);

  console.log(`bodies ${bodies.map((b) => `${b.name}:${b.points.length}`).join(' ')} total ${totalPoints}`);
  console.log(`frames ${frames.length}, clip ${frames.at(-1)!.t} s, events ${JSON.stringify(events)}`);
  console.log(`checks ${JSON.stringify(out.meta.checks)}`);
  console.log(`receipt ${JSON.stringify(out.meta.receipt)}`);
  console.log(`MEASURED ${JSON.stringify(measured)}`);
  console.log(`FILE ${OUT} ${size} bytes`);
}

await main();
