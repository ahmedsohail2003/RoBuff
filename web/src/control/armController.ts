import { JAW_ACTUATOR, type Simulation, type Vec3 } from '../sim/simulation';
import { applyGrip, currentGrip, GRIP_RATE_PER_S, slew } from './grip';
import { closingYawFor } from './grasp';
import { ArmIk, type IkResult } from './ik';
import { TargetSmoother } from './targetSmoother';
import { clampTarget } from './workspace';

/** IK iterations per control tick. The solver starts from the last answer, so few are needed. */
const IK_ITERATIONS_PER_TICK = 8;

export interface ControllerStatus {
  /** What was asked for, before the workspace clamp. */
  target: Vec3 | null;
  /** After the workspace clamp and smoothing: what the IK is solving for. */
  smoothed: Vec3 | null;
  grip: number | null;
  /** The grip sent to the jaw this tick, slewed toward grip. */
  appliedGrip: number | null;
  ik: IkResult | null;
}

/**
 * Turns a gripper-site target and a grip amount into actuator commands: workspace clamp,
 * smoothing, inverse kinematics with the jaws kept pointing down, then position commands.
 *
 * Actuator values come from so_arm100.xml: position servos with kp 50 N m/rad, critically
 * damped, torque limited to 3.5 N m. A servo with only kp sags by (gravity torque / kp), so
 * each command adds qfrc_bias / kp: the torque that holds the arm against gravity, as a
 * feedforward. The command stays inside the joint's control range.
 */
export class ArmController {
  useGravityFeedforward = true;
  private target: Vec3 | null = null;
  private grip: number | null = null;
  /** The grip actually sent to the jaw, slewed toward `grip`. */
  private appliedGrip: number | null = null;
  private q: number[] = [];
  private lastIk: IkResult | null = null;
  private readonly smoother = new TargetSmoother();
  private readonly kp: number[];

  constructor(
    private readonly sim: Simulation,
    private readonly ik: ArmIk,
  ) {
    const gain = sim.model.actuator_gainprm as Float64Array;
    this.kp = this.ik.lower.map((_, i) => gain[10 * i]!);
    this.reset();
  }

  setTarget(target: Vec3): void {
    this.target = [...target];
  }

  setGrip(grip: number): void {
    this.grip = Math.min(1, Math.max(0, grip));
  }

  /** Forget targets and hold where the arm is now. Call after the simulation resets. */
  reset(): void {
    this.target = null;
    this.grip = null;
    this.appliedGrip = null;
    this.lastIk = null;
    this.q = this.sim.getJointPos().slice(0, this.ik.lower.length);
    this.smoother.reset(this.ik.forward(this.q));
  }

  status(): ControllerStatus {
    return { target: this.target, smoothed: this.smoother.value, grip: this.grip, appliedGrip: this.appliedGrip, ik: this.lastIk };
  }

  /** One control update covering dt seconds of simulated time. */
  tick(dt: number): void {
    if (this.grip !== null) {
      const from = this.appliedGrip ?? currentGrip(this.sim, JAW_ACTUATOR);
      this.appliedGrip = slew(from, this.grip, GRIP_RATE_PER_S, dt);
      applyGrip(this.sim, this.appliedGrip);
    }
    if (!this.target) return;
    const goal = this.smoother.step(clampTarget(this.target), dt);
    this.lastIk = this.ik.solve({ position: goal, closingYaw: closingYawFor(goal) }, this.q, IK_ITERATIONS_PER_TICK);
    this.q = this.lastIk.q;
    const bias = this.useGravityFeedforward ? this.sim.getArmBiasForces() : [];
    this.sim.setArmCtrl(this.q.map((value, i) => value + (bias[i] ?? 0) / this.kp[i]!));
  }
}
