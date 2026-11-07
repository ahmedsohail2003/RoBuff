// Drop the object on a plane in a minimal scene and see where it comes to rest.
// Takes an already-loaded MuJoCo module, so it runs the same in Node and in a browser Worker.

import type { MainModule } from '@mujoco/mujoco';
import { extents, sweepYaw } from './geometry';
import { GRAVITY, ROLL_NOTE_MM, SETTLE_MAX_SECONDS } from './limits';
import { lines } from './messages';
import { MjcfNamer, toMjcf, type MjcfFragment } from './mjcf';
import type { Receipt, ReceiptStep, RestPose } from './receipt';

/** Floor friction: a design value for a table top, not measured. */
export const FLOOR_FRICTION = 0.8;
/** Same step, cone and impratio as the arm model (Menagerie trs_so_arm100). */
export const SETTLE_TIMESTEP = 0.002;

export interface SettleOptions {
  gravity_m_s2?: number;
  /** Stop at this many seconds if it has not come to rest. Default 1.5. */
  max_seconds?: number;
  /** Step exactly this many times instead of stopping when still. */
  fixed_steps?: number;
  /** Below this average speed over the window, and in contact, it counts as still. Default 2 mm/s. */
  still_mm_s?: number;
  /** Below this turn rate it counts as still. Default 3 degrees/s. */
  still_deg_s?: number;
  /** Window length in steps for judging stillness. Default 25 (50 ms). */
  still_steps?: number;
}

export interface SettleReport {
  compile_ms: number;
  steps: number;
  sim_seconds: number;
  gravity_m_s2: number;
  /** In contact and still at the end. */
  settled: boolean;
  touched: boolean;
  finite: boolean;
  rest_position_m: [number, number, number];
  /** w, x, y, z. */
  rest_quat: [number, number, number, number];
  rolled_mm: number;
  rotated_deg: number;
  /** Average over the last still-window (default 50 ms), from pose change. */
  final_speed_mm_s: number;
  final_turn_deg_s: number;
  /** Instantaneous angular speed at the last step: contact chatter shows up here, not in the pose. */
  jitter_deg_s: number;
  /** Lowest hull point above the floor at rest, in mm. Negative is penetration. */
  rest_lowest_mm: number;
  rest_height_mm: number;
  /** Narrowest jaw yaw in the rest pose, for re-aiming. */
  rest_yaw_deg: number;
  rest_narrow_width_mm: number;
  model_mass_kg: number;
  step: ReceiptStep;
}

export function settleSceneXml(fragments: readonly MjcfFragment[], gravity: number): string {
  return (
    `<mujoco model="settle">` +
    `<option timestep="${SETTLE_TIMESTEP}" gravity="0 0 ${-gravity}" cone="elliptic" impratio="10"/>` +
    `<asset>${fragments.map((f) => f.asset).join('')}</asset>` +
    `<worldbody><geom name="floor" type="plane" size="1 1 0.05" friction="${FLOOR_FRICTION} 0.005 0.0001"/>` +
    `${fragments.map((f) => f.body).join('')}</worldbody>` +
    `</mujoco>`
  );
}

function rotate(q: readonly number[], x: number, y: number, z: number): [number, number, number] {
  const [w, qx, qy, qz] = q as [number, number, number, number];
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [x + w * tx + (qy * tz - qz * ty), y + w * ty + (qz * tx - qx * tz), z + w * tz + (qx * ty - qy * tx)];
}

/** Hull points of a body at a world pose (origin position, w x y z quaternion). */
export function hullAtPose(points: ArrayLike<number>, position: readonly number[], quat: readonly number[]): Float64Array {
  const out = new Float64Array(points.length);
  for (let i = 0; i + 2 < points.length; i += 3) {
    const [x, y, z] = rotate(quat, points[i]!, points[i + 1]!, points[i + 2]!);
    out[i] = x + position[0]!;
    out[i + 1] = y + position[1]!;
    out[i + 2] = z + position[2]!;
  }
  return out;
}

/** The rest pose the lift test aims from: the hull where it lies, its narrowest jaw yaws in world axes, and its height. */
export function restPoseOf(receipt: Receipt, position: readonly number[], quat: readonly number[], scene: RestPose['scene']): RestPose {
  const rested = hullAtPose(receipt.hull!.points, position, quat);
  const box = extents(rested);
  const sweep = sweepYaw(rested);
  return {
    scene,
    position_m: [position[0]!, position[1]!, position[2]!],
    quat: [quat[0]!, quat[1]!, quat[2]!, quat[3]!],
    yaw_candidates_deg: sweep.map((s) => s.yaw_deg),
    narrow_width_mm: sweep[0]!.width * 1000,
    lowest_mm: box.min[2] * 1000,
    height_mm: box.size[2] * 1000,
  };
}

/** Settle one validated object. Throws only if the receipt has nothing to export. */
export function settle(mj: MainModule, receipt: Receipt, options: SettleOptions = {}): SettleReport {
  const gravity = options.gravity_m_s2 ?? receipt.gravity_m_s2 ?? GRAVITY.earth;
  const fragment = toMjcf(receipt, { namer: new MjcfNamer() });
  const xml = settleSceneXml([fragment], gravity);
  const maxSteps = options.fixed_steps ?? Math.round((options.max_seconds ?? SETTLE_MAX_SECONDS) / SETTLE_TIMESTEP);
  const stillSpeed = (options.still_mm_s ?? 2) / 1000;
  const stillTurn = ((options.still_deg_s ?? 3) * Math.PI) / 180;
  const stillNeeded = options.still_steps ?? 25;

  const t0 = performance.now();
  const model = mj.MjModel.from_xml_string(xml);
  const data = new mj.MjData(model);
  const compileMs = performance.now() - t0;
  try {
    mj.mj_forward(model, data);
    const startCom = Array.from((data.xipos as Float64Array).subarray(3, 6));
    const startQuat = Array.from((data.qpos as Float64Array).subarray(3, 7));
    const modelMass = (model.body_mass as Float64Array)[1]!;

    // Stillness is judged on how far the pose moved over the last window, not on the
    // instantaneous velocity: resting contacts chatter (measured: 7-13 deg/s of jitter on a
    // 22 g iron shard whose pose did not change in the 4th decimal for 2 s).
    const windowSteps = Math.max(1, stillNeeded);
    const comHistory: number[][] = [];
    const quatHistory: number[][] = [];
    let steps = 0;
    let touched = false;
    let finite = true;
    let speed = 0;
    let turn = 0;
    let jitter = 0;
    let still = false;
    while (steps < maxSteps) {
      mj.mj_step(model, data);
      steps++;
      const qvel = data.qvel as Float64Array;
      jitter = Math.hypot(qvel[3]!, qvel[4]!, qvel[5]!);
      const contact = data.ncon > 0;
      touched ||= contact;
      const com = Array.from((data.xipos as Float64Array).subarray(3, 6));
      const q = Array.from((data.qpos as Float64Array).subarray(3, 7));
      if (!com.every(Number.isFinite) || !q.every(Number.isFinite) || !Number.isFinite(jitter)) {
        finite = false;
        break;
      }
      comHistory.push(com);
      quatHistory.push(q);
      if (comHistory.length > windowSteps + 1) {
        comHistory.shift();
        quatHistory.shift();
      }
      const span = (comHistory.length - 1) * SETTLE_TIMESTEP;
      if (span > 0) {
        const c0 = comHistory[0]!;
        const q0 = quatHistory[0]!;
        speed = Math.hypot(com[0]! - c0[0]!, com[1]! - c0[1]!, com[2]! - c0[2]!) / span;
        const d = Math.abs(q[0]! * q0[0]! + q[1]! * q0[1]! + q[2]! * q0[2]! + q[3]! * q0[3]!);
        turn = (2 * Math.acos(Math.min(1, d))) / span;
      }
      still = contact && comHistory.length > windowSteps && speed < stillSpeed && turn < stillTurn;
      if (options.fixed_steps === undefined && still) break;
    }

    const qpos = Array.from((data.qpos as Float64Array).subarray(0, 7));
    const com = Array.from((data.xipos as Float64Array).subarray(3, 6));
    finite &&= qpos.every(Number.isFinite) && com.every(Number.isFinite);
    const quat = qpos.slice(3, 7) as [number, number, number, number];
    const dot = Math.abs(quat[0] * startQuat[0]! + quat[1] * startQuat[1]! + quat[2] * startQuat[2]! + quat[3] * startQuat[3]!);
    const rotatedDeg = (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
    const rolledMm = Math.hypot(com[0]! - startCom[0]!, com[1]! - startCom[1]!) * 1000;

    // The hull in its rest pose: where is the floor contact, and which yaw is narrowest now.
    const rested = hullAtPose(receipt.hull!.points, qpos, quat);
    const box = extents(rested);
    const restSweep = sweepYaw(rested)[0]!;
    const settled = touched && still && finite;
    const seconds = steps * SETTLE_TIMESTEP;

    let note: ReceiptStep;
    if (!settled && options.fixed_steps === undefined) {
      note = { code: 'SETTLE_TIMEOUT', ok: false, measured: seconds, limit: options.max_seconds ?? SETTLE_MAX_SECONDS, unit: 's', message: lines.settleTimeout(seconds, touched, gravity), action: 'note' };
    } else if (rolledMm > ROLL_NOTE_MM) {
      note = { code: 'ROLLS', ok: true, measured: rolledMm, limit: ROLL_NOTE_MM, unit: 'mm', message: lines.rolls(rolledMm, rotatedDeg), action: 'note' };
    } else {
      note = { code: 'SETTLED', ok: true, measured: rolledMm, limit: ROLL_NOTE_MM, unit: 'mm', message: lines.settled(rolledMm, rotatedDeg), action: 'note' };
    }

    return {
      compile_ms: compileMs,
      steps,
      sim_seconds: seconds,
      gravity_m_s2: gravity,
      settled,
      touched,
      finite,
      rest_position_m: [qpos[0]!, qpos[1]!, qpos[2]!],
      rest_quat: quat,
      rolled_mm: rolledMm,
      rotated_deg: rotatedDeg,
      final_speed_mm_s: speed * 1000,
      final_turn_deg_s: (turn * 180) / Math.PI,
      jitter_deg_s: (jitter * 180) / Math.PI,
      rest_lowest_mm: box.min[2] * 1000,
      rest_height_mm: box.size[2] * 1000,
      rest_yaw_deg: restSweep.yaw_deg,
      rest_narrow_width_mm: restSweep.width * 1000,
      model_mass_kg: modelMass,
      step: note,
    };
  } finally {
    data.delete();
    model.delete();
  }
}

/** The receipt with the settle note placed before the lift line, and its rest pose, which the lift test aims from. */
export function withSettle(receipt: Receipt, report: SettleReport, rest?: RestPose): Receipt {
  return withSettleStep(receipt, report.step, rest ?? restPoseOf(receipt, report.rest_position_m, report.rest_quat, 'plane'));
}

/** Same, for a settle run somewhere else, such as the live scene with the arm. */
export function withSettleStep(receipt: Receipt, step: ReceiptStep, rest: RestPose): Receipt {
  const steps = receipt.steps.slice();
  const liftAt = steps.findIndex((s) => s.code.startsWith('LIFT_'));
  steps.splice(liftAt < 0 ? steps.length : liftAt, 0, step);
  return { ...receipt, steps, rest };
}
