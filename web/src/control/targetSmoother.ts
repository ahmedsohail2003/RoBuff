import type { Vec3 } from '../sim/simulation';
import { CONTROL_GAINS } from './gains';

export interface SmootherOptions {
  /** First-order time constant: about 63% of a step is covered in this time, in seconds. */
  timeConstantS: number;
  /** Speed limit in metres per second, so a jump in the input never whips the arm. */
  maxSpeed: number;
}

/** The time constant is tuned in control/gains.ts (was 0.12 s). */
export const DEFAULT_SMOOTHER: SmootherOptions = { timeConstantS: CONTROL_GAINS.smootherTimeConstantS, maxSpeed: 0.25 };

/** Moves a point toward a goal with a first-order lag and a speed limit. */
export class TargetSmoother {
  private position: Vec3 | null = null;

  constructor(readonly options: SmootherOptions = DEFAULT_SMOOTHER) {}

  get value(): Vec3 | null {
    return this.position;
  }

  reset(position: Vec3): void {
    this.position = [...position];
  }

  step(goal: Vec3, dt: number): Vec3 {
    if (!this.position) {
      this.position = [...goal];
      return [...goal];
    }
    const blend = 1 - Math.exp(-dt / this.options.timeConstantS);
    let move: Vec3 = [0, 1, 2].map((i) => (goal[i]! - this.position![i]!) * blend) as Vec3;
    const distance = Math.hypot(...move);
    const limit = this.options.maxSpeed * dt;
    if (distance > limit) move = move.map((value) => (value * limit) / distance) as Vec3;
    this.position = [0, 1, 2].map((i) => this.position![i]! + move[i]!) as Vec3;
    return [...this.position];
  }
}
