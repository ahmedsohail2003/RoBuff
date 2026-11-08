// What the guardrail hands back: every step it ran, in order, with numbers.

import type { ConvexHull } from './hull';
import type { Band } from './limits';
import type { Material } from './materials';
import type { ObjectMesh } from './mesh';
import { fnv1a } from './rng';
import type { ObjectSpec, PartShape } from './spec';

export type StepCode =
  | 'SPEC_CLAMPED'
  | 'BAD_MESH'
  | 'SANITY_OK'
  | 'LAID_DOWN'
  | 'THICKENED'
  | 'DECIMATED'
  | 'HULL_OK'
  | 'HULL_FILL'
  | 'YAW_CHOSEN'
  | 'TOO_WIDE'
  | 'TOO_SMALL'
  | 'TOO_TALL'
  | 'TOO_SHORT'
  | 'TOO_LONG'
  | 'OUTSIDE_HAND_BAND'
  | 'SCALE_OK'
  | 'NO_SINGLE_SCALE'
  | 'PARTS'
  | 'MASS_OK'
  | 'TOO_HEAVY'
  | 'FRICTION_OK'
  | 'SLIPS'
  | 'GRIP_OK'
  | 'GRIP_HEIGHT'
  | 'SETTLED'
  | 'ROLLS'
  | 'SETTLE_TIMEOUT'
  | 'LIFT_NOT_RUN'
  | 'LIFT_OK'
  | 'LIFT_FAILED'
  | 'LIFT_ERROR';

/** none: check passed as asked. rescaled/clamped: changed to fit. refused: stops the object. note: information. pending: not run yet. */
export type StepAction = 'none' | 'note' | 'rescaled' | 'clamped' | 'refused' | 'pending';

export interface ReceiptStep {
  code: StepCode;
  ok: boolean;
  measured: number | null;
  limit: number | null;
  unit: string;
  message: string;
  action: StepAction;
}

export type Verdict = 'PASS' | 'ADJUSTED' | 'REFUSED' | 'READY_FOR_LIFT_TEST';

export interface FrictionCheck {
  mu: number;
  required_mu: number;
  clamp_n: number;
  gravity_m_s2: number;
  /** 2 * mu * CLAMP_N / (m * g): the weight part alone. Infinite at zero gravity. */
  grip_ratio: number;
  /**
   * How far off square the pads meet the hull, degrees: the best of the yaws the lift test
   * would try. Null if it could not be measured. Squeezing pushes the object out unless mu is
   * at least its tangent, at any gravity.
   */
  squeeze_angle_deg: number | null;
  /** The yaw that angle was measured at, degrees in the object's own axes. */
  squeeze_yaw_deg: number | null;
  /** tan(squeeze_angle_deg): friction needed just to keep it from squeezing out. */
  squeeze_mu: number;
  /** m * g / CLAMP_N: friction needed for its weight, with the factor-2 margin. */
  weight_mu: number;
  /** True when the MJCF gives the object priority="1", so MuJoCo uses this mu instead of the pads' 1.0. */
  priority: boolean;
}

export interface LiftAttempt {
  yaw_deg: number;
  rise_mm: number;
  passed: boolean;
  note: string;
  /** Seconds the object stayed at least the pass rise up while held, when the tester reports it. */
  hold_s?: number;
  /** Wall-clock milliseconds the tester took for this attempt, when it reports it. */
  wall_ms?: number;
}

/** Where the object came to rest, from a settle in MuJoCo. The lift test aims from here. */
export interface RestPose {
  /** plane: a bare floor in its own scene. arena: the live scene with the arm, the same compiled model the lift test uses. */
  scene: 'plane' | 'arena';
  /** Body origin in world metres. */
  position_m: [number, number, number];
  /** w, x, y, z. */
  quat: [number, number, number, number];
  /** Jaw yaws to try in the rest pose, narrowest width first. */
  yaw_candidates_deg: number[];
  narrow_width_mm: number;
  /** Lowest and highest hull point above the floor at rest, in mm. */
  lowest_mm: number;
  height_mm: number;
}

export interface LiftStatus {
  status: 'not_run' | 'passed' | 'failed' | 'error';
  message: string;
  attempts: LiftAttempt[];
}

/** One part of an assembly after sizing: what MuJoCo gets as one mesh geom with its own mass. */
export interface ReceiptPart {
  name: string;
  shape: PartShape;
  color: string;
  /** Final, scaled part mesh, in the same frame as the receipt's mesh. */
  mesh: ObjectMesh;
  /** The part's own convex hull: its collision shape and its mass. */
  hull: ConvexHull;
  volume_cm3: number;
  mass_kg: number;
}

export interface Receipt {
  schema: 's5-receipt-v1';
  verdict: Verdict;
  /** True when anything was rescaled or clamped to fit. */
  adjusted: boolean;
  spec: ObjectSpec;
  band: Band;
  material: Material;
  density_g_cc: number;
  gravity_m_s2: number;
  steps: ReceiptStep[];
  /** Final, scaled mesh, centred in x and y with its lowest point at z = 0. Null if no mesh could be made safe. */
  mesh: ObjectMesh | null;
  /** Hull of the final mesh. MJCF export uses its points. */
  hull: ConvexHull | null;
  scale: number | null;
  requested_size_mm: [number, number, number];
  size_mm: [number, number, number] | null;
  narrow_width_mm: number | null;
  hull_volume_cm3: number | null;
  hull_fill_percent: number | null;
  mass_kg: number | null;
  friction: FrictionCheck | null;
  yaw_deg: number | null;
  /** Yaws to try in order, narrowest width first. */
  yaw_candidates_deg: number[];
  /** Height of the grip point above the floor, in mm, for the arm planner. */
  grip_z_mm: number | null;
  /** Rest pose after settling, or null if it was never settled. The lift test uses it when present. */
  rest: RestPose | null;
  lift: LiftStatus;
  /** Assemblies only: each part, in order. mass_kg is their sum. */
  parts?: ReceiptPart[];
}

export function isRefused(steps: readonly ReceiptStep[]): boolean {
  return steps.some((s) => s.action === 'refused');
}

/** Hash of the final mesh bytes, to spot identical objects. */
export function meshHash(mesh: ObjectMesh): string {
  return fnv1a(new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength), Number.parseInt(fnv1a(new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength)), 16));
}

/** A JSON-friendly summary: numbers and messages, mesh arrays replaced by counts and a hash. */
export function receiptSummary(receipt: Receipt): Record<string, unknown> {
  const { mesh, hull, parts, ...rest } = receipt;
  const summary: Record<string, unknown> = {
    ...rest,
    mesh: mesh ? { vertices: mesh.positions.length / 3, triangles: mesh.indices.length / 3, hash: meshHash(mesh) } : null,
    hull: hull ? { vertices: hull.points.length / 3, triangles: hull.faces.length / 3 } : null,
  };
  if (parts) {
    summary.parts = parts.map(({ mesh: m, hull: h, ...part }) => ({ ...part, vertices: m.positions.length / 3, hull_vertices: h.points.length / 3 }));
  }
  return summary;
}
