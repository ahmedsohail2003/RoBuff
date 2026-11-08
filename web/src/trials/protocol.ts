// The ghost-gate trial protocol (pre-registered in the evidence report §4, copied into
// docs/results/PROTOCOL.md): the trial order, the stable-lift rule, the cutoff, and the
// per-trial measurements, all on the truth arm's simulated clock.

import { MIN_CONFIDENCE, type ArmCommand } from '../control/handMapping';
import { jawContactSummary } from '../control/pickCheck';
import type { HandState } from '../input/handState';
import type { Simulation, Vec3 } from '../sim/simulation';
import { jawCentre, ROCK_BODY, ROCK_GEOM, type DelayMode } from '../delay/dualSim';
import { ErrorStats } from '../delay/ghostError';

export type Condition = 'direct' | 'ghost_off' | 'ghost_on';

export const CONDITION_MODE: Record<Condition, DelayMode> = {
  direct: 'direct',
  ghost_off: 'moon_ghost_off',
  ghost_on: 'moon_ghost_on',
};

export const CONDITION_LABEL: Record<Condition, string> = {
  direct: 'DIRECT (no delay)',
  ghost_off: 'GHOST OFF',
  ghost_on: 'GHOST ON',
};

export const PROTOCOL = {
  directWarmups: 4,
  practicePerCondition: 2,
  /** Each block is off, on, on, off. */
  blockOrder: ['ghost_off', 'ghost_on', 'ghost_on', 'ghost_off'] as Condition[],
  defaultBlocks: 3,
  cutoffS: 90,
  /** Stable lift: the rock's lowest point this high above the floor ... */
  liftMinM: 0.03,
  /** ... with both jaw pads touching it, unbroken for this long. */
  liftHoldS: 2.0,
  /** Reach ends when the jaw centre is this close to the rock centre. */
  reachWithinM: 0.015,
  /** A reversal needs this much travel between direction changes, per axis. */
  reversalTravelM: 0.01,
  /** A pause: commanded speed under this ... */
  pauseSpeedMS: 0.01,
  /** ... for at least this long. */
  pauseMinS: 0.5,
  /** Hand lost for longer than this in one stretch is a technical fault: the trial is excluded and repeated at the end. */
  excludeHandLostS: 5,
  countdownS: 3,
  /** A held rock (both pads, lowest point this high) that ends up back on the floor ... */
  dropHeldM: 0.01,
  /** ... below this, with no pad contact, counts as one drop. */
  dropFloorM: 0.005,
} as const;

export interface TrialSpec {
  condition: Condition;
  practice: boolean;
  /** 'warmup', 'practice', or the logged block number. */
  block: string;
  /** Set when this trial repeats an excluded one. */
  repeatOf?: number;
}

/** 4 direct warm-ups, 2 practice trials per delay condition, then off-on-on-off blocks. */
export function trialOrder(blocks: number = PROTOCOL.defaultBlocks): TrialSpec[] {
  const order: TrialSpec[] = [];
  for (let i = 0; i < PROTOCOL.directWarmups; i++) order.push({ condition: 'direct', practice: true, block: 'warmup' });
  for (let i = 0; i < PROTOCOL.practicePerCondition; i++) {
    order.push({ condition: 'ghost_off', practice: true, block: 'practice' });
    order.push({ condition: 'ghost_on', practice: true, block: 'practice' });
  }
  for (let b = 1; b <= blocks; b++) for (const condition of PROTOCOL.blockOrder) order.push({ condition, practice: false, block: String(b) });
  return order;
}

/** The rock's lowest point above the floor, from its box half sizes and orientation. */
export function rockLowestZ(sim: Simulation): number | null {
  const pos = sim.getBodyPos(ROCK_BODY);
  if (!pos) return null;
  const half = sim.geomHalfSize(ROCK_GEOM);
  const data = sim.mjData;
  const xpos = data.xpos as Float64Array;
  // The rock is the last body in the arena scene (arena.xml adds it after the arm).
  const body = xpos.length / 3 - 1;
  if (xpos[3 * body] !== pos[0] || xpos[3 * body + 1] !== pos[1] || xpos[3 * body + 2] !== pos[2]) return pos[2] - half[2];
  const xmat = data.xmat as Float64Array;
  const r = xmat.subarray(9 * body + 6, 9 * body + 9);
  return pos[2] - (Math.abs(r[0]!) * half[0] + Math.abs(r[1]!) * half[1] + Math.abs(r[2]!) * half[2]);
}

export interface TrialOutcome {
  success: boolean;
  completion_s: number | null;
  reach_s: number | null;
  grasp_s: number | null;
  grasp_attempts: number;
  drops: number;
  reversals: number;
  pauses: number;
  max_ghost_err_mm: number | null;
  mean_ghost_err_mm: number | null;
  hand_lost_ms: number;
  render_fps_median: number | null;
  excluded: boolean;
  exclude_reason: string;
  /** Simulated seconds from GO to the end of the trial. */
  ran_s: number;
}

/** Counts direction changes on one axis with at least `travel` between them. */
export class ReversalCounter {
  private anchor: number | null = null;
  private extreme = 0;
  private dir = 0;
  count = 0;

  constructor(private readonly travel: number) {}

  add(v: number): void {
    if (this.anchor === null) {
      this.anchor = v;
      this.extreme = v;
      return;
    }
    if (this.dir === 0) {
      if (Math.abs(v - this.anchor) >= this.travel) {
        this.dir = Math.sign(v - this.anchor);
        this.extreme = v;
      }
      return;
    }
    if (this.dir > 0) {
      if (v > this.extreme) this.extreme = v;
      else if (this.extreme - v >= this.travel) {
        this.count++;
        this.dir = -1;
        this.extreme = v;
      }
    } else if (v < this.extreme) this.extreme = v;
    else if (v - this.extreme >= this.travel) {
      this.count++;
      this.dir = 1;
      this.extreme = v;
    }
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Measures one trial from GO, one control tick at a time, on the truth arm's state. A drop
 * does not end the trial; it ends at a stable lift (success) or at the cutoff (failure).
 */
export class TrialMeter {
  private readonly reversals = [0, 1, 2].map(() => new ReversalCounter(PROTOCOL.reversalTravelM));
  private readonly errors = new ErrorStats();
  private readonly fps: number[] = [];
  private lastTarget: Vec3 | null = null;
  private lastT: number | null = null;
  private pauseS = 0;
  private pauseCount = 0;
  private liftStart: number | null = null;
  private reachAt: number | null = null;
  private firstCloseAt: number | null = null;
  private closed = false;
  private attempts = 0;
  private held = false;
  private dropCount = 0;
  private lostS = 0;
  private lostRunS = 0;
  private outcome: TrialOutcome | null = null;

  constructor(
    readonly tGo: number,
    readonly cutoffS: number = PROTOCOL.cutoffS,
  ) {}

  get done(): TrialOutcome | null {
    return this.outcome;
  }

  /** One control tick. Returns the outcome when the trial has ended. */
  tick(t: number, truth: Simulation, hand: HandState | null, command: ArmCommand | null, ghostErrorMm: number | null, fps: number | null): TrialOutcome | null {
    if (this.outcome) return this.outcome;
    const dt = this.lastT === null ? 0 : t - this.lastT;
    this.lastT = t;
    const since = t - this.tGo;
    if (fps !== null && Number.isFinite(fps) && fps > 0) this.fps.push(fps);
    if (ghostErrorMm !== null) this.errors.add(ghostErrorMm);

    // Hand loss, on the operator's live hand.
    const lost = !hand || !(hand.confidence >= MIN_CONFIDENCE);
    if (lost) {
      this.lostS += dt;
      this.lostRunS += dt;
    } else this.lostRunS = 0;

    // Commanded target: reversals and pauses.
    if (command) {
      command.target.forEach((v, k) => this.reversals[k]!.add(v));
      if (command.grip >= 0.5 && !this.closed) {
        this.closed = true;
        this.attempts++;
        if (this.firstCloseAt === null) this.firstCloseAt = t;
      } else if (command.grip < 0.5) this.closed = false;
    }
    const speed = command && this.lastTarget && dt > 0 ? Math.hypot(command.target[0] - this.lastTarget[0], command.target[1] - this.lastTarget[1], command.target[2] - this.lastTarget[2]) / dt : 0;
    if (command) this.lastTarget = command.target;
    if (speed < PROTOCOL.pauseSpeedMS) this.pauseS += dt;
    else this.endPause();

    // Truth state: reach, drops, stable lift.
    const rock = truth.getBodyPos(ROCK_BODY);
    const jaw = jawCentre(truth);
    if (this.reachAt === null && rock && jaw && Math.hypot(rock[0] - jaw[0], rock[1] - jaw[1], rock[2] - jaw[2]) <= PROTOCOL.reachWithinM) this.reachAt = t;
    const lowest = rockLowestZ(truth) ?? 0;
    const touching = jawContactSummary(truth.contactsOf(ROCK_BODY)).jawsTouching.length;
    if (touching === 2 && lowest >= PROTOCOL.dropHeldM) this.held = true;
    else if (this.held && touching === 0 && lowest < PROTOCOL.dropFloorM) {
      this.held = false;
      this.dropCount++;
    }
    if (touching === 2 && lowest >= PROTOCOL.liftMinM) {
      this.liftStart ??= t;
      if (t - this.liftStart >= PROTOCOL.liftHoldS - 1e-9) return this.finish(true, t);
    } else this.liftStart = null;

    if (this.lostRunS > PROTOCOL.excludeHandLostS) return this.finish(false, t, `hand lost ${this.lostRunS.toFixed(1)} s`);
    if (since >= this.cutoffS) return this.finish(false, t);
    return null;
  }

  private endPause(): void {
    if (this.pauseS >= PROTOCOL.pauseMinS) this.pauseCount++;
    this.pauseS = 0;
  }

  private finish(success: boolean, t: number, excludeReason = ''): TrialOutcome {
    this.endPause();
    const tLift = success ? this.liftStart! : null;
    this.outcome = {
      success,
      completion_s: tLift !== null ? tLift - this.tGo : null,
      reach_s: success && this.reachAt !== null ? this.reachAt - this.tGo : null,
      grasp_s: tLift !== null && this.firstCloseAt !== null ? tLift - this.firstCloseAt : null,
      grasp_attempts: this.attempts,
      drops: this.dropCount,
      reversals: this.reversals.reduce((sum, r) => sum + r.count, 0),
      pauses: this.pauseCount,
      max_ghost_err_mm: this.errors.max,
      mean_ghost_err_mm: this.errors.mean,
      hand_lost_ms: this.lostS * 1000,
      render_fps_median: median(this.fps),
      excluded: excludeReason !== '',
      exclude_reason: excludeReason,
      ran_s: t - this.tGo,
    };
    return this.outcome;
  }
}
