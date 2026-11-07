import type { Simulation } from '../sim/simulation';

/**
 * Fastest the jaw command may move, in full strokes per second (open to closed in 0.4 s).
 * A pinch latch switches 0 -> 1 in one frame; slewing the command keeps the jaw from
 * slamming into the object. Starting value.
 */
export const GRIP_RATE_PER_S = 2.5;

/** Maps a grip command to the jaw actuator: 0 is fully open, 1 is fully closed. */
export function applyGrip(sim: Simulation, grip: number): void {
  const [closed, open] = sim.jawRange();
  const amount = Math.min(1, Math.max(0, grip));
  sim.setJawCtrl(open + (closed - open) * amount);
}

/** The grip amount (0 open .. 1 closed) the jaw actuator is commanded to now. */
export function currentGrip(sim: Simulation, jawActuator: number): number {
  const [closed, open] = sim.jawRange();
  const ctrl = sim.getCtrl()[jawActuator] ?? open;
  return Math.min(1, Math.max(0, (open - ctrl) / (open - closed)));
}

/** Moves value toward goal by at most rate * dt. */
export function slew(value: number, goal: number, ratePerS: number, dtS: number): number {
  const limit = ratePerS * dtS;
  return value + Math.min(limit, Math.max(-limit, goal - value));
}
