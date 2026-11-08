// Runs the trial session: the app generates the order, sets each trial's mode on the delay
// rig (always with the truth rock and Moon gravity, the protocol's fixed settings), resets the
// scene at GO, measures the trial on the truth arm's clock, and logs one row. Rows are kept
// in localStorage too, so a reload does not lose a sitting.

import { DelayRig, GHOST_ROCK, ROCK_SEED, ROCK_SIZE_MM, ROCK_SPEC_ID, TRUTH_ROCK, rockMassKg, type TickInfo } from '../delay/dualSim';
import { gravity, setGravity } from '../sim/gravity';
import { sessionIdAt, trialRow, type SessionSettings, type TrialRow } from './logger';
import { CONDITION_MODE, PROTOCOL, TrialMeter, trialOrder, type TrialOutcome, type TrialSpec } from './protocol';

export type RunnerState = 'idle' | 'countdown' | 'running' | 'finished';

const STORE_KEY = 'aftergrip.trials.v1';

interface Stored {
  settings: SessionSettings;
  order: TrialSpec[];
  rows: TrialRow[];
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export interface RunnerOptions {
  operator: string;
  buildId: string;
  blocks?: number;
  fps: () => number;
  /** Persist rows between page loads (the browser); tests turn it off. */
  persist?: boolean;
}

export class TrialRunner {
  state: RunnerState = 'idle';
  settings: SessionSettings;
  order: TrialSpec[];
  rows: TrialRow[] = [];
  /** Countdown number on screen (3, 2, 1, 0 = GO), or null. */
  countdown: number | null = null;
  lastOutcome: TrialOutcome | null = null;
  error: string | null = null;
  readonly changed = new Set<() => void>();
  private meter: TrialMeter | null = null;
  private context: { spec: TrialSpec; trial_idx: number; t_go_iso: string; input_source: string } | null = null;
  private finishResolve: ((row: TrialRow) => void) | null = null;
  private readonly listener = (tick: TickInfo) => this.onTick(tick);

  constructor(
    private readonly rig: DelayRig,
    private readonly options: RunnerOptions,
  ) {
    const stored = options.persist ? this.load() : null;
    if (stored) {
      this.settings = stored.settings;
      this.order = stored.order;
      this.rows = stored.rows;
    } else {
      this.settings = this.newSettings();
      this.order = trialOrder(options.blocks);
    }
  }

  /** 0-based index of the next trial to run, or null when the order is done. */
  get nextIndex(): number | null {
    return this.rows.length < this.order.length ? this.rows.length : null;
  }

  get current(): TrialSpec | null {
    return this.context?.spec ?? (this.nextIndex === null ? null : this.order[this.nextIndex]!);
  }

  /** Throws the session away and starts a new one (new id, fresh order). */
  newSession(): void {
    if (this.state === 'countdown' || this.state === 'running') return;
    this.settings = this.newSettings();
    this.order = trialOrder(this.options.blocks);
    this.rows = [];
    this.lastOutcome = null;
    this.state = 'idle';
    this.save();
    this.emit();
  }

  /**
   * Runs the next trial: mode and rock set, countdown (wall-clock seconds), GO resets the
   * scene, and the trial runs until a stable lift or the cutoff. Resolves with the logged row.
   */
  async runNext(countdownS: number = PROTOCOL.countdownS): Promise<TrialRow> {
    if (this.state === 'countdown' || this.state === 'running') throw new Error('a trial is already running');
    const index = this.nextIndex;
    if (index === null) throw new Error('every trial in the order is done');
    const spec = this.order[index]!;
    this.error = null;
    try {
      await this.rig.setMode(CONDITION_MODE[spec.condition], { rock: true });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.emit();
      throw error;
    }
    if (gravity.current.id !== 'moon') setGravity('moon');
    this.state = 'countdown';
    for (let n = Math.ceil(countdownS); n >= 1; n--) {
      this.countdown = n;
      this.emit();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    this.countdown = 0;
    // GO: arm home, rock at its start pose, the source restarted, the clock at zero.
    this.rig.resetScene();
    const source = this.rig.loop.source;
    const inner = this.rig.delayedSource?.inner ?? source;
    this.context = { spec, trial_idx: index + 1, t_go_iso: new Date().toISOString(), input_source: inner?.kind ?? 'none' };
    this.meter = new TrialMeter(this.rig.loop.sim.time, PROTOCOL.cutoffS);
    this.state = 'running';
    this.rig.listeners.add(this.listener);
    this.emit();
    setTimeout(() => {
      if (this.countdown === 0) {
        this.countdown = null;
        this.emit();
      }
    }, 800);
    return new Promise((resolve) => (this.finishResolve = resolve));
  }

  /** Simulated seconds since GO, while a trial runs. */
  elapsed(): number | null {
    return this.state === 'running' && this.meter ? this.rig.loop.sim.time - this.meter.tGo : null;
  }

  private onTick(tick: TickInfo): void {
    if (!this.meter || !this.context) return;
    const outcome = this.meter.tick(tick.t, tick.truth, tick.liveHand, tick.liveCommand, tick.error?.gripper_mm ?? null, this.options.fps());
    if (!outcome) return;
    this.rig.listeners.delete(this.listener);
    const row = trialRow(this.settings, { ...this.context, gravity_mps2: gravity.current.value }, outcome);
    this.rows.push(row);
    // An excluded trial is repeated at the end of the order.
    if (outcome.excluded) this.order.push({ ...this.context.spec, repeatOf: this.context.trial_idx });
    this.lastOutcome = outcome;
    this.meter = null;
    this.context = null;
    this.state = this.nextIndex === null ? 'finished' : 'idle';
    this.save();
    this.emit();
    const resolve = this.finishResolve;
    this.finishResolve = null;
    resolve?.(row);
  }

  private newSettings(): SessionSettings {
    return {
      session_id: sessionIdAt(new Date()),
      operator: this.options.operator,
      delay_oneway_ms: Math.round(this.rig.delayS * 1000),
      rock_spec_id: ROCK_SPEC_ID,
      rock_seed: ROCK_SEED,
      rock_size_mm: ROCK_SIZE_MM,
      rock_mass_true_g: rockMassKg(TRUTH_ROCK) * 1000,
      rock_mass_ghost_g: rockMassKg(GHOST_ROCK) * 1000,
      friction_true: TRUTH_ROCK.friction,
      friction_ghost: GHOST_ROCK.friction,
      cutoff_s: PROTOCOL.cutoffS,
      build_id: this.options.buildId,
    };
  }

  private load(): Stored | null {
    const raw = storage()?.getItem(STORE_KEY);
    if (!raw) return null;
    try {
      const stored = JSON.parse(raw) as Stored;
      // A stored session from another operator name or build is kept only if it matches this page's settings.
      if (stored.settings.operator !== this.options.operator) return null;
      return stored;
    } catch {
      return null;
    }
  }

  private save(): void {
    if (!this.options.persist) return;
    storage()?.setItem(STORE_KEY, JSON.stringify({ settings: this.settings, order: this.order, rows: this.rows } satisfies Stored));
  }

  private emit(): void {
    for (const listener of this.changed) listener();
  }
}
