import { worldToPalm } from '../control/handMapping';
import { HandMapper } from './handMapper';
import type { HandState, InputSource } from './handState';
import { PickScript, type PickPlan, type PickSample } from './pickScript';
import { syntheticLandmarks } from './syntheticHand';

/**
 * A scripted virtual hand. It runs the pick script on simulated time, turns each scripted
 * gripper target into a palm position with the inverse of the hand mapping, draws 21
 * landmarks for it, and passes them through the same HandMapper the webcam uses (One Euro
 * filter, palm-size depth, pinch hysteresis). Deterministic: no camera, no wall clock.
 */
export class SyntheticSource implements InputSource {
  readonly kind = 'synthetic';
  private script: PickScript;
  private startMs: number | null = null;
  private last: PickSample | null = null;
  private readonly mapper = new HandMapper();

  constructor(private plan: () => PickPlan) {
    this.script = new PickScript(plan());
  }

  poll(tMs: number): HandState | null {
    if (this.startMs === null) this.startMs = tMs;
    const sample = this.script.sample((tMs - this.startMs) / 1000);
    this.last = sample;
    const landmarks = syntheticLandmarks(worldToPalm(sample.target), sample.grip);
    return this.mapper.update({ landmarks, score: 1 }, tMs);
  }

  /** Re-reads the plan, so a moved box gets a new path. */
  reset(): void {
    this.script = new PickScript(this.plan());
    this.startMs = null;
    this.last = null;
    this.mapper.reset();
  }

  describe(): Record<string, unknown> {
    return {
      phase: this.last?.phase ?? null,
      phaseIndex: this.last?.phaseIndex ?? -1,
      waypoint: this.last?.waypoint ?? null,
      settled: this.last?.settled ?? false,
      done: this.last?.done ?? false,
      scriptTime: this.last?.t ?? 0,
      scriptGrip: this.last?.grip ?? 0,
      phases: this.script.phases.map((phase) => phase.name),
      mapping: 'landmarks -> HandMapper',
      mapper: this.mapper.stats(),
    };
  }

  dispose(): void {}
}
