import type { HandState, InputSource } from '../input/handState';
import type { Simulation } from '../sim/simulation';
import type { ArmController } from './armController';
import { handToCommand } from './handMapping';

/** Physics steps per control update: 5 x 2 ms = 100 Hz, fixed in simulated time. */
export const PHYSICS_STEPS_PER_CONTROL = 5;

/**
 * Interleaves control and physics on simulated time only, so a run is the same whatever
 * the frame rate: the browser and the unit tests step the same loop.
 */
export class ControlLoop {
  source: InputSource | null = null;
  lastHand: HandState | null = null;
  private stepsSinceControl = 0;

  constructor(
    readonly sim: Simulation,
    readonly controller: ArmController,
  ) {}

  advance(steps: number): void {
    for (let i = 0; i < steps; i++) {
      if (this.stepsSinceControl === 0) this.control();
      this.sim.step(1);
      this.stepsSinceControl = (this.stepsSinceControl + 1) % PHYSICS_STEPS_PER_CONTROL;
    }
  }

  /**
   * Simulation back to its keyframe, controller holding, input source restarted.
   * arrange runs after the keyframe reset and before the source re-reads the scene.
   */
  reset(arrange?: (sim: Simulation) => void): void {
    this.sim.reset();
    arrange?.(this.sim);
    this.controller.reset();
    this.source?.reset();
    this.lastHand = null;
    this.stepsSinceControl = 0;
  }

  private control(): void {
    if (this.source) {
      const hand = this.source.poll(this.sim.time * 1000);
      this.lastHand = hand;
      const command = hand ? handToCommand(hand) : null;
      if (command) {
        this.controller.setTarget(command.target);
        this.controller.setGrip(command.grip);
      }
    }
    this.controller.tick(PHYSICS_STEPS_PER_CONTROL * this.sim.timestep);
  }
}
