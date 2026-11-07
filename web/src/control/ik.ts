import type { DoubleBuffer, MjData, MjModel } from '@mujoco/mujoco';
import type { Mujoco } from '../sim/mujocoRuntime';
import type { Vec3 } from '../sim/simulation';
import { dampedLeastSquares } from './linalg';

/** The joints the solver moves, in actuator order. The jaw is commanded separately. */
export const IK_JOINTS = ['Rotation', 'Pitch', 'Elbow', 'Wrist_Pitch', 'Wrist_Roll'] as const;

/** About 1.1 degrees of tool tilt counts as pointing straight down. */
const POINTING_TOLERANCE_RAD = 0.02;

export interface IkOptions {
  /** Damping lambda in the damped least squares step. Larger is steadier near singularities, slower to converge. */
  damping: number;
  /** Largest change of any joint in one iteration, in radians. */
  maxStepRad: number;
  /** Kept between the solution and each joint limit, in radians. */
  limitMarginRad: number;
  /** Metres of position error that one radian of tool orientation error is worth. 0 solves position only. */
  orientationWeight: number;
  /** Stop when the position error is below this, in metres. */
  tolerance: number;
}

export const DEFAULT_IK_OPTIONS: IkOptions = {
  damping: 0.03,
  maxStepRad: 0.1,
  limitMarginRad: 0.01,
  // A grid scan at x = 0 (y -0.16 to -0.40 m, z 0.02 to 0.20 m) gave at most 8 mm position
  // error with 0.03, against 47 mm with 0.1: position wins and the tool tilts instead.
  orientationWeight: 0.03,
  tolerance: 0.0005,
};

export interface ToolPose {
  /** World position for the control site. */
  position: Vec3;
  /**
   * Heading of the jaw closing axis about world z, in radians, with the jaws pointing
   * straight down. Null leaves the tool orientation free.
   */
  closingYaw: number | null;
}

export interface IkResult {
  q: number[];
  positionError: number;
  /** Angle between the jaw pointing axis and straight down, in radians. */
  pointingError: number;
  iterations: number;
}

/**
 * Damped least squares position and tool-down control on MuJoCo's own site Jacobian.
 * It works on a private MjData, so solving never disturbs the simulation.
 */
export class ArmIk {
  readonly lower: number[] = [];
  readonly upper: number[] = [];
  private readonly data: MjData;
  private readonly qposAdr: number[] = [];
  private readonly dofAdr: number[] = [];
  private readonly siteId: number;
  private readonly jacp: DoubleBuffer;
  private readonly jacr: DoubleBuffer;

  constructor(
    private readonly mujoco: Mujoco,
    private readonly model: MjModel,
    siteName: string,
    readonly options: IkOptions = DEFAULT_IK_OPTIONS,
  ) {
    this.data = new mujoco.MjData(model);
    this.siteId = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_SITE.value, siteName);
    if (this.siteId < 0) throw new Error(`model has no site named ${siteName}`);
    const range = model.jnt_range as Float64Array;
    for (const joint of IK_JOINTS) {
      const id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT.value, joint);
      if (id < 0) throw new Error(`model has no joint named ${joint}`);
      this.qposAdr.push((model.jnt_qposadr as Int32Array)[id]!);
      this.dofAdr.push((model.jnt_dofadr as Int32Array)[id]!);
      this.lower.push(range[2 * id]! + options.limitMarginRad);
      this.upper.push(range[2 * id + 1]! - options.limitMarginRad);
    }
    this.jacp = new mujoco.DoubleBuffer(3 * model.nv);
    this.jacr = new mujoco.DoubleBuffer(3 * model.nv);
  }

  /** Site position for joint angles q, from forward kinematics. */
  forward(q: readonly number[]): Vec3 {
    this.setJoints(q);
    const p = this.data.site_xpos as Float64Array;
    const i = 3 * this.siteId;
    return [p[i]!, p[i + 1]!, p[i + 2]!];
  }

  clampToLimits(q: readonly number[]): number[] {
    return q.map((value, i) => Math.min(this.upper[i]!, Math.max(this.lower[i]!, value)));
  }

  /** Iterates from seed toward the pose. The result always respects the joint limits. */
  solve(pose: ToolPose, seed: readonly number[], maxIterations: number): IkResult {
    const n = IK_JOINTS.length;
    const useOrientation = pose.closingYaw !== null && this.options.orientationWeight > 0;
    const rows = useOrientation ? 6 : 3;
    const w = this.options.orientationWeight;
    let q = this.clampToLimits(seed);
    let iterations = 0;
    let positionError = Infinity;
    let pointingError = 0;
    const jacobian = new Float64Array(rows * n);
    const error = new Float64Array(rows);

    for (;;) {
      this.setJoints(q);
      const p = this.data.site_xpos as Float64Array;
      const m = this.data.site_xmat as Float64Array;
      const s = 3 * this.siteId;
      const r = 9 * this.siteId;
      error[0] = pose.position[0] - p[s]!;
      error[1] = pose.position[1] - p[s + 1]!;
      error[2] = pose.position[2] - p[s + 2]!;
      positionError = Math.hypot(error[0], error[1], error[2]);
      // Site frame columns: local x is the jaw closing axis, local -y points out of the jaws.
      const closing: Vec3 = [m[r]!, m[r + 3]!, m[r + 6]!];
      const pointing: Vec3 = [-m[r + 1]!, -m[r + 4]!, -m[r + 7]!];
      pointingError = Math.acos(Math.min(1, Math.max(-1, -pointing[2])));
      if (useOrientation) {
        const yaw = pose.closingYaw!;
        const wantClosing: Vec3 = [Math.cos(yaw), Math.sin(yaw), 0];
        const a = cross(pointing, [0, 0, -1]);
        const b = cross(closing, wantClosing);
        for (let k = 0; k < 3; k++) error[3 + k] = w * (a[k]! + b[k]!);
      }
      const orientationDone = !useOrientation || pointingError < POINTING_TOLERANCE_RAD;
      if (positionError < this.options.tolerance && orientationDone) break;
      if (iterations >= maxIterations) break;

      this.mujoco.mj_jacSite(this.model, this.data, this.jacp, this.jacr, this.siteId);
      const jp = this.jacp.GetView() as Float64Array;
      const jr = this.jacr.GetView() as Float64Array;
      const nv = this.model.nv;
      for (let k = 0; k < n; k++) {
        const dof = this.dofAdr[k]!;
        for (let row = 0; row < 3; row++) {
          jacobian[row * n + k] = jp[row * nv + dof]!;
          if (useOrientation) jacobian[(3 + row) * n + k] = w * jr[row * nv + dof]!;
        }
      }
      const dq = this.limitedStep(jacobian, error, rows, q);
      if (!dq) break;
      let largest = 0;
      for (const value of dq) largest = Math.max(largest, Math.abs(value));
      const scale = largest > this.options.maxStepRad ? this.options.maxStepRad / largest : 1;
      q = this.clampToLimits(q.map((value, k) => value + scale * dq[k]!));
      iterations++;
    }
    return { q, positionError, pointingError, iterations };
  }

  /**
   * A damped least squares step in which any joint resting on a limit, and pushed further
   * into it, is frozen and the step recomputed. Plain clamping would waste the share of the
   * step given to that joint, and the other joints would never make up for it.
   */
  private limitedStep(jacobian: Float64Array, error: Float64Array, rows: number, q: number[]): Float64Array | null {
    const n = IK_JOINTS.length;
    const active = jacobian.slice();
    const frozen = new Array<boolean>(n).fill(false);
    for (let pass = 0; pass <= n; pass++) {
      const dq = dampedLeastSquares(active, error, rows, n, this.options.damping);
      if (!dq || !dq.every(Number.isFinite)) return null;
      let changed = false;
      for (let k = 0; k < n; k++) {
        if (frozen[k]) continue;
        const atLower = q[k]! <= this.lower[k]! + 1e-9 && dq[k]! < 0;
        const atUpper = q[k]! >= this.upper[k]! - 1e-9 && dq[k]! > 0;
        if (atLower || atUpper) {
          frozen[k] = true;
          changed = true;
          for (let row = 0; row < rows; row++) active[row * n + k] = 0;
        }
      }
      if (!changed) return dq;
    }
    return null;
  }

  dispose(): void {
    this.jacp.delete();
    this.jacr.delete();
    this.data.delete();
  }

  private setJoints(q: readonly number[]): void {
    const qpos = this.data.qpos as Float64Array;
    q.forEach((value, k) => {
      qpos[this.qposAdr[k]!] = value;
    });
    // Positions, then the com-based quantities mj_jacSite reads.
    this.mujoco.mj_kinematics(this.model, this.data);
    this.mujoco.mj_comPos(this.model, this.data);
  }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
