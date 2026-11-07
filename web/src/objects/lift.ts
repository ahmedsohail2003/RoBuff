// The only step that can prove a lift: a simulated lift by the arm. The arm controller
// is built in another slice, so this file holds the interface it must meet, and the
// bookkeeping that turns its answer into a verdict.

import { widthAtYaw } from './geometry';
import { GRIP_Z_MIN, LIFT_HEIGHT, LIFT_MAX_ATTEMPTS, LIFT_PASS_RISE } from './limits';
import { lines } from './messages';
import { toMjcf, type MjcfFragment } from './mjcf';
import type { LiftAttempt, Receipt, ReceiptStep, RestPose } from './receipt';
import { hullAtPose } from './settle';

export interface LiftRequest {
  fragment: MjcfFragment;
  /**
   * Jaw closing axis heading. With a rest pose it is in world axes, measured on the hull
   * where it came to rest; without one it is in the object's own axes, before settling.
   */
  yaw_deg: number;
  yaw_frame: 'rest-world' | 'object';
  /** Where the object came to rest, when it was settled. The tester grips it there. */
  rest: RestPose | null;
  /** Object width along the jaw axis at this yaw. Research: open the jaw to this plus 16 mm. */
  width_mm: number;
  /** Grip point height above the floor: half the height it stands, but at least GRIP_Z_MIN. */
  grip_z_mm: number;
  mass_kg: number;
  mu: number;
  gravity_m_s2: number;
  lift_height_mm: number;
  pass_rise_mm: number;
}

export interface LiftResult {
  /** Always true: a tester reports a simulation, never a real arm. */
  simulated: true;
  /** How far the object rose while held, in mm. */
  rise_mm: number;
  note?: string;
  /** Seconds it stayed at least pass_rise_mm up with the jaw closed. */
  hold_s?: number;
  /** Wall-clock milliseconds this attempt took. */
  wall_ms?: number;
}

export interface LiftTester {
  readonly name: string;
  testLift(request: LiftRequest): Promise<LiftResult>;
}

const MM = 1000;

/**
 * Run the simulated lift test on a READY_FOR_LIFT_TEST receipt: narrowest yaw first, then the
 * next two. When the receipt has a rest pose (it was settled), the yaws, widths and grip height
 * are measured on the hull where it came to rest, so the test aims from where it stopped.
 */
export async function proveLift(receipt: Receipt, tester: LiftTester): Promise<Receipt> {
  if (receipt.verdict !== 'READY_FOR_LIFT_TEST' || !receipt.hull || receipt.mass_kg === null || !receipt.friction || receipt.grip_z_mm === null) {
    return receipt;
  }
  const fragment = toMjcf(receipt);
  const needMm = LIFT_PASS_RISE * MM;
  const attempts: LiftAttempt[] = [];
  let outcome: ReceiptStep | null = null;
  let passedYaw: number | null = null;

  const rest = receipt.rest;
  const points = rest ? hullAtPose(receipt.hull.points, rest.position_m, rest.quat) : receipt.hull.points;
  const yaws = rest ? rest.yaw_candidates_deg : receipt.yaw_candidates_deg;
  const gripZ = rest ? Math.max(rest.height_mm / 2, GRIP_Z_MIN * MM) : receipt.grip_z_mm;

  for (const yaw of yaws.slice(0, LIFT_MAX_ATTEMPTS)) {
    const request: LiftRequest = {
      fragment,
      yaw_deg: yaw,
      yaw_frame: rest ? 'rest-world' : 'object',
      rest,
      width_mm: widthAtYaw(points, yaw) * MM,
      grip_z_mm: gripZ,
      mass_kg: receipt.mass_kg,
      mu: receipt.friction.mu,
      gravity_m_s2: receipt.gravity_m_s2,
      lift_height_mm: LIFT_HEIGHT * MM,
      pass_rise_mm: needMm,
    };
    let result: LiftResult;
    try {
      result = await tester.testLift(request);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      outcome = { code: 'LIFT_ERROR', ok: false, measured: null, limit: needMm, unit: 'mm', message: lines.liftError(reason), action: 'pending' };
      break;
    }
    const rise = Number.isFinite(result.rise_mm) ? result.rise_mm : 0;
    const passed = result.simulated === true && rise >= needMm;
    const attempt: LiftAttempt = { yaw_deg: yaw, rise_mm: rise, passed, note: result.note ?? '' };
    if (result.hold_s !== undefined) attempt.hold_s = result.hold_s;
    if (result.wall_ms !== undefined) attempt.wall_ms = result.wall_ms;
    attempts.push(attempt);
    if (passed) {
      passedYaw = yaw;
      outcome = { code: 'LIFT_OK', ok: true, measured: rise, limit: needMm, unit: 'mm', message: lines.liftOk(rise, needMm, yaw), action: 'none' };
      break;
    }
  }
  if (!outcome) {
    const best = attempts.reduce((m, a) => Math.max(m, a.rise_mm), 0);
    outcome = { code: 'LIFT_FAILED', ok: false, measured: best, limit: needMm, unit: 'mm', message: lines.liftFailed(attempts.length, best, needMm), action: 'refused' };
  }

  const steps = receipt.steps.filter((s) => s.code !== 'LIFT_NOT_RUN').concat(outcome);
  const status = outcome.code === 'LIFT_OK' ? 'passed' : outcome.code === 'LIFT_FAILED' ? 'failed' : 'error';
  return {
    ...receipt,
    steps,
    yaw_deg: passedYaw ?? receipt.yaw_deg,
    verdict: status === 'passed' ? (receipt.adjusted ? 'ADJUSTED' : 'PASS') : status === 'failed' ? 'REFUSED' : 'READY_FOR_LIFT_TEST',
    lift: { status, message: outcome.message, attempts },
  };
}
