// The Earth-Moon delay rig: the truth arm (the live control loop) and the ghost arm (its own
// compiled model and control loop), stepped together on simulated time.
//
// Direct: one simulation, nothing changes from the plain loop.
// Moon, ghost off: the operator's hand states go into a command line and the truth arm reads
//   them 1.28 s later; the screen draws the truth arm's body poses from a view line, another
//   1.28 s late.
// Moon, ghost on: as above, and the ghost gets every hand state at once and is drawn live.
//
// The hand state is what is delayed. Every source's filtering (One Euro, pinch latch) runs
// before the line, and the command is made from the state by the same pure handToCommand, so
// delaying the state delays the command and nothing else.
//
// The hidden mismatch: the truth rock is 2.3 g/cm3 with friction 0.6; the ghost's copy of it
// is 1.6 g/cm3 with friction 0.8 (both inside the documented C-type range; the evidence
// report §4). Mass is a model property, so the ghost has its own compiled model. The rock is
// the arena's 30 mm block: its mass, inertia and friction are rewritten on the model, and its
// geom gets priority 1 so its own friction is used against the pads and floor (MuJoCo takes
// the larger of two frictions when priorities are equal, and the pads and floor are 1.0).

import type { MjModel } from '@mujoco/mujoco';
import { ArmController } from '../control/armController';
import { ControlLoop, PHYSICS_STEPS_PER_CONTROL } from '../control/controlLoop';
import { handToCommand, type ArmCommand } from '../control/handMapping';
import { ArmIk } from '../control/ik';
import type { HandState, InputSource } from '../input/handState';
import { FIXED_PAD_SITE, GRIPPER_SITE, MOVING_PAD_SITE } from '../sim/armXml';
import { registerGravityTarget, applyGravityTo } from '../sim/gravity';
import { rockReturn } from '../sim/rockReturn';
import type { Mujoco } from '../sim/mujocoRuntime';
import { Simulation, type Vec3 } from '../sim/simulation';
import { DelayLine, ONE_WAY_DELAY_S } from './delayLine';
import { ghostError, type ArmSample, type GhostError } from './ghostError';

export type DelayMode = 'direct' | 'moon_ghost_off' | 'moon_ghost_on';
export const DELAY_MODES: readonly DelayMode[] = ['direct', 'moon_ghost_off', 'moon_ghost_on'];

export const ROCK_BODY = 'cube';
export const ROCK_GEOM = 'cube_geom';
/** Edge of the arena block, from arena.xml (half size 0.015 m). */
export const ROCK_SIZE_MM = 30;
export const ROCK_SPEC_ID = 'arena-block-30mm';
/** The block is a fixed shape: no generator, so no seed. 0 is logged. */
export const ROCK_SEED = 0;

export interface RockParams {
  density_kg_m3: number;
  friction: number;
}

export const TRUTH_ROCK: RockParams = { density_kg_m3: 2300, friction: 0.6 };
export const GHOST_ROCK: RockParams = { density_kg_m3: 1600, friction: 0.8 };

export function rockMassKg(rock: RockParams): number {
  return rock.density_kg_m3 * (ROCK_SIZE_MM / 1000) ** 3;
}

/** Control ticks kept in each line: 4 s at 100 Hz, more than the 2.56 s the meter reaches back. */
const LINE_TICKS = 400;
/** Per-tick live hand states, read by the ghost at the same tick: a short line is enough. */
const LIVE_TICKS = 16;

/**
 * Rewrites the rock's mass, inertia (scaled with the mass: same shape, uniform density),
 * friction and priority on a compiled model, then recomputes the model's derived constants.
 * Returns a function that puts the old values back.
 */
export function applyRock(mujoco: Mujoco, sim: Simulation, rock: RockParams): () => void {
  const model = sim.model;
  const body = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, ROCK_BODY);
  const geom = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM.value, ROCK_GEOM);
  if (body < 0 || geom < 0) throw new Error('this scene has no rock block (the arena cube)');
  const mass = model.body_mass as Float64Array;
  const inertia = model.body_inertia as Float64Array;
  const friction = model.geom_friction as Float64Array;
  const priority = model.geom_priority as Int32Array;
  const saved = { mass: mass[body]!, inertia: Array.from(inertia.subarray(3 * body, 3 * body + 3)), friction: friction[3 * geom]!, priority: priority[geom]! };
  const newMass = rockMassKg(rock);
  const scale = newMass / saved.mass;
  mass[body] = newMass;
  for (let k = 0; k < 3; k++) inertia[3 * body + k] = saved.inertia[k]! * scale;
  friction[3 * geom] = rock.friction;
  priority[geom] = 1;
  mujoco.mj_setConst(model, sim.mjData);
  return () => {
    const m = sim.model.body_mass as Float64Array;
    const i = sim.model.body_inertia as Float64Array;
    m[body] = saved.mass;
    for (let k = 0; k < 3; k++) i[3 * body + k] = saved.inertia[k]!;
    (sim.model.geom_friction as Float64Array)[3 * geom] = saved.friction;
    (sim.model.geom_priority as Int32Array)[geom] = saved.priority;
    mujoco.mj_setConst(sim.model, sim.mjData);
  };
}

/** The rock as the model holds it now: mass in grams, sliding friction, priority. */
export function rockOnModel(mujoco: Mujoco, model: MjModel): { mass_g: number; friction: number; priority: number } | null {
  const body = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, ROCK_BODY);
  const geom = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM.value, ROCK_GEOM);
  if (body < 0 || geom < 0) return null;
  return {
    mass_g: (model.body_mass as Float64Array)[body]! * 1000,
    friction: (model.geom_friction as Float64Array)[3 * geom]!,
    priority: (model.geom_priority as Int32Array)[geom]!,
  };
}

/** Middle of the two jaw tip pads: the jaw centre. */
export function jawCentre(sim: Simulation): Vec3 | null {
  const a = sim.getSitePos(FIXED_PAD_SITE);
  const b = sim.getSitePos(MOVING_PAD_SITE);
  return a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] : null;
}

function armSample(sim: Simulation): ArmSample {
  return { gripper: sim.getSitePos(GRIPPER_SITE)!, rock: sim.getBodyPos(ROCK_BODY) };
}

/**
 * Wraps the operator's input source. Each poll reads the source now, keeps the state in the
 * live line (for the ghost and the screen), and hands the truth loop the state from 1.28 s ago.
 */
export class DelayedSource implements InputSource {
  readonly line = new DelayLine<HandState | null>(LINE_TICKS);
  readonly live = new DelayLine<HandState | null>(LIVE_TICKS);
  /** The latest state straight from the source. */
  lastLive: HandState | null = null;

  constructor(
    public inner: InputSource,
    readonly delayS: number = ONE_WAY_DELAY_S,
  ) {}

  get kind(): InputSource['kind'] {
    return this.inner.kind;
  }

  poll(tMs: number): HandState | null {
    const t = tMs / 1000;
    const hand = this.inner.poll(tMs);
    this.lastLive = hand;
    this.line.push(t, hand);
    this.live.push(t, hand);
    return this.line.read(t - this.delayS)?.value ?? null;
  }

  reset(): void {
    this.line.clear();
    this.live.clear();
    this.lastLive = null;
    this.inner.reset();
  }

  describe(): Record<string, unknown> {
    return { ...this.inner.describe(), delayed_s: this.delayS };
  }

  dispose(): void {
    this.inner.dispose();
  }
}

/**
 * The operator's own source: the inner one when a Moon mode wraps it in a DelayedSource. Voice
 * parks and restores through these two, so the delay wrapper itself is never parked and its
 * line keeps one continuous history (a parked wrapper replays stale states and, after a mode
 * switch, pushes an earlier time into its line).
 */
export function operatorSource(loop: { source: InputSource | null }): InputSource | null {
  return loop.source instanceof DelayedSource ? loop.source.inner : loop.source;
}

/** Puts a source in the operator's seat: inside the delay wrapper when there is one. */
export function setOperatorSource(loop: { source: InputSource | null }, source: InputSource | null): void {
  if (loop.source instanceof DelayedSource) {
    if (source) loop.source.inner = source;
    else loop.source = null;
  } else {
    loop.source = source;
  }
}

/** The ghost's input: the live hand state at the same tick, with no delay. */
class GhostTap implements InputSource {
  constructor(private readonly delayed: () => DelayedSource | null) {}

  get kind(): InputSource['kind'] {
    return this.delayed()?.kind ?? 'mouse';
  }

  poll(tMs: number): HandState | null {
    return this.delayed()?.live.read(tMs / 1000)?.value ?? null;
  }

  reset(): void {}

  describe(): Record<string, unknown> {
    return { ghost: true };
  }

  dispose(): void {}
}

export interface GhostWorld {
  sim: Simulation;
  loop: ControlLoop;
  ik: ArmIk;
  unregisterGravity: () => void;
}

/** What a control tick reports to listeners such as the trial logger. */
export interface TickInfo {
  t: number;
  mode: DelayMode;
  truth: Simulation;
  ghost: Simulation | null;
  /** The operator's hand right now (not delayed). */
  liveHand: HandState | null;
  /** The command made from it, or null when the hand is not usable. */
  liveCommand: ArmCommand | null;
  /** Ghost error as the meter shows it now, or null (ghost off, or less than 2.56 s of history). */
  error: GhostError | null;
}

/** Shown when a switch to a delay mode takes a spawned object out and puts the rock back. */
export const ROCK_BACK_CAPTION = 'Putting the 30 mm test rock back for the delay mode.';

export interface SetModeOptions {
  /** Use the truth rock (2.3 g/cm3, friction 0.6) in this mode. Default: in the Moon modes only. Trials use it in Direct too. */
  rock?: boolean;
}

export class DelayRig {
  mode: DelayMode = 'direct';
  /** Set when the rig left a Moon mode on its own, and why. */
  notice: string | null = null;
  readonly delayS = ONE_WAY_DELAY_S;
  readonly listeners = new Set<(tick: TickInfo) => void>();
  private delayed: DelayedSource | null = null;
  private ghost: GhostWorld | null = null;
  private ghostPending: Promise<GhostWorld> | null = null;
  private restoreRock: (() => void) | null = null;
  private rockOn = false;
  /** The live simulation when the mode was set; a spawn swaps it and ends the Moon mode. */
  private truthSim: Simulation;
  private lastTime: number;
  private steps = 0;
  private readonly poseLine = new DelayLine<{ xpos: Float64Array; xquat: Float64Array }>(LINE_TICKS);
  private readonly truthLine = new DelayLine<ArmSample>(LINE_TICKS);
  private readonly ghostLine = new DelayLine<ArmSample>(LINE_TICKS);
  private lastError: GhostError | null = null;

  /**
   * ghostModel compiles the ghost's own model of the same scene (the browser uses the
   * physics-only copy, about 0.1-0.3 s). It is called once, when a ghost is first needed.
   */
  constructor(
    private readonly mujoco: Mujoco,
    readonly loop: ControlLoop,
    private readonly ghostModel: () => MjModel | Promise<MjModel>,
    private readonly ghostRock: RockParams = GHOST_ROCK,
    private readonly truthRock: RockParams = TRUTH_ROCK,
  ) {
    this.truthSim = loop.sim;
    this.lastTime = loop.sim.time;
  }

  get moon(): boolean {
    return this.mode !== 'direct';
  }

  get ghostOn(): boolean {
    return this.mode === 'moon_ghost_on';
  }

  get rockApplied(): boolean {
    return this.rockOn;
  }

  get ghostSim(): Simulation | null {
    return this.ghost?.sim ?? null;
  }

  /** The source wrapper while a Moon mode is on. */
  get delayedSource(): DelayedSource | null {
    return this.delayed;
  }

  /** True when the live scene has the rock block (an object spawned into the slot replaces it). */
  hasRock(): boolean {
    return this.loop.sim.getBodyPos(ROCK_BODY) !== null;
  }

  /** Builds the ghost world now, so the first switch to the ghost does not wait. */
  prepareGhost(): Promise<GhostWorld> {
    if (this.ghost) return Promise.resolve(this.ghost);
    this.ghostPending ??= Promise.resolve(this.ghostModel()).then((model) => {
      applyGravityTo(model);
      const sim = new Simulation(this.mujoco, model);
      const ik = new ArmIk(this.mujoco, model, GRIPPER_SITE);
      const loop = new ControlLoop(sim, new ArmController(sim, ik));
      loop.source = new GhostTap(() => this.delayed);
      applyRock(this.mujoco, sim, this.ghostRock);
      const unregisterGravity = registerGravityTarget('ghost', () => this.ghost?.sim.model ?? null);
      this.ghost = { sim, loop, ik, unregisterGravity };
      return this.ghost;
    });
    return this.ghostPending;
  }

  /**
   * Switches mode and resets the scene (arm home, rock at its start pose, clock at zero).
   * When a spawned object holds the slot, the 30 mm test rock is put back first.
   */
  async setMode(mode: DelayMode, options: SetModeOptions = {}): Promise<void> {
    const wantRock = options.rock ?? mode !== 'direct';
    const needRock = mode !== 'direct' || wantRock;
    if (needRock && !this.hasRock() && !rockReturn()) {
      throw new Error('The delay modes use the 30 mm test rock, and an object is in the slot now. Reload the page to get the rock back.');
    }
    if (mode === 'moon_ghost_on') await this.prepareGhost();
    let caption: string | null = null;
    if (needRock && !this.hasRock()) {
      if (!rockReturn()?.() || !this.hasRock()) {
        throw new Error('The delay modes use the 30 mm test rock. An object request is still running; try again when it finishes.');
      }
      caption = ROCK_BACK_CAPTION;
    }
    if (this.truthSim !== this.loop.sim) {
      // The live model was swapped (a spawn, or the rock put back): the old rock edits went with it.
      this.restoreRock = null;
      this.rockOn = false;
    }
    this.notice = caption;
    // Leave the old mode.
    if (this.delayed) {
      if (this.loop.source === this.delayed) this.loop.source = this.delayed.inner;
      this.delayed = null;
    }
    if (this.loop.source instanceof DelayedSource) this.loop.source = this.loop.source.inner;
    if (this.rockOn !== wantRock || this.truthSim !== this.loop.sim) {
      this.restoreRock?.();
      this.restoreRock = null;
      this.rockOn = false;
      if (wantRock) {
        this.restoreRock = applyRock(this.mujoco, this.loop.sim, this.truthRock);
        this.rockOn = true;
      }
    }
    this.truthSim = this.loop.sim;
    this.mode = mode;
    if (mode !== 'direct' && this.loop.source) {
      this.delayed = new DelayedSource(this.loop.source, this.delayS);
      this.loop.source = this.delayed;
    }
    this.resetScene();
  }

  /** Keyframe reset of truth and ghost together, lines cleared. */
  resetScene(): void {
    this.loop.reset();
    this.afterReset();
  }

  /** Steps truth (and the ghost, when shown) by this many physics steps, recording each control tick. */
  advance(steps: number): void {
    this.follow();
    const ghost = this.ghostOn ? this.ghost : null;
    if (ghost) ghost.loop.stopLatch = this.loop.stopLatch;
    for (let i = 0; i < steps; i++) {
      this.loop.advance(1);
      ghost?.loop.advance(1);
      this.steps++;
      if (this.steps % PHYSICS_STEPS_PER_CONTROL === 0) this.tick(ghost);
    }
    this.lastTime = this.loop.sim.time;
    if (this.delayed) {
      // The screen's hand banner and range line follow the operator's hand, not the delayed copy.
      this.loop.lastHand = this.delayed.lastLive;
      this.loop.lastCommand = this.delayed.lastLive ? handToCommand(this.delayed.lastLive) : null;
    }
  }

  /** Truth body poses to draw: 1.28 s old in the Moon modes, or null for the live ones. */
  viewPoses(): { xpos: Float64Array; xquat: Float64Array } | null {
    if (!this.moon) return null;
    const t = this.loop.sim.time;
    return (this.poseLine.read(t - this.delayS) ?? this.poseLine.oldest())?.value ?? null;
  }

  /** Ghost body poses, live, or null when the ghost is not shown. */
  ghostPoses(): { xpos: Float64Array; xquat: Float64Array } | null {
    return this.ghostOn && this.ghost ? this.ghost.sim.bodyPoses() : null;
  }

  /** The truth gripper and rock as the screen shows them now. */
  seenTruth(): ArmSample {
    if (!this.moon) return armSample(this.loop.sim);
    const t = this.loop.sim.time;
    return (this.truthLine.read(t - this.delayS) ?? this.truthLine.oldest())?.value ?? armSample(this.loop.sim);
  }

  /** The ghost gripper and rock now (live), or null. */
  ghostNow(): ArmSample | null {
    return this.ghostOn && this.ghost ? armSample(this.ghost.sim) : null;
  }

  /** The meter's reading: truth as seen now against the ghost 2.56 s ago. Null until there is that much history. */
  error(): GhostError | null {
    return this.ghostOn ? this.lastError : null;
  }

  /** The command the operator is giving now, not delayed. */
  liveCommand(): ArmCommand | null {
    if (this.delayed) return this.delayed.lastLive ? handToCommand(this.delayed.lastLive) : null;
    return this.loop.lastCommand;
  }

  liveHand(): HandState | null {
    return this.delayed ? this.delayed.lastLive : this.loop.lastHand;
  }

  dispose(): void {
    // Give the shared live model its own rock back, so the rig leaves nothing behind.
    this.restoreRock?.();
    this.restoreRock = null;
    this.rockOn = false;
    const ghost = this.ghost;
    this.ghost = null;
    this.ghostPending = null;
    if (!ghost) return;
    ghost.unregisterGravity();
    ghost.ik.dispose();
    ghost.sim.mjData.delete();
    ghost.sim.model.delete();
  }

  /** Reacts to changes made from outside: a reset, a replaced input source, a spawned object. */
  private follow(): void {
    if (this.truthSim !== this.loop.sim) {
      // The object slot swapped the live model: the rock and its mismatch are gone with it.
      const was = this.mode;
      if (this.delayed && this.loop.source === this.delayed) this.loop.source = this.delayed.inner;
      this.delayed = null;
      this.restoreRock = null;
      this.rockOn = false;
      this.mode = 'direct';
      this.truthSim = this.loop.sim;
      if (was !== 'direct') this.notice = 'An object was spawned, so the scene left the Moon mode (the delay modes use the 30 mm test rock).';
      this.afterReset();
      return;
    }
    if (this.loop.sim.time < this.lastTime - 1e-9) {
      // Someone reset the live loop (a test hook, the stop banner, the object panel).
      this.ghost?.loop.reset();
      this.clearLines();
    }
    if (this.moon && this.loop.source && this.loop.source !== this.delayed) {
      // A new input source (camera denied, mouse chosen): delay it too.
      if (this.delayed) this.delayed.inner = this.loop.source;
      else this.delayed = new DelayedSource(this.loop.source, this.delayS);
      this.loop.source = this.delayed;
    }
  }

  private afterReset(): void {
    this.ghost?.loop.reset();
    this.clearLines();
  }

  private clearLines(): void {
    this.steps = 0;
    this.poseLine.clear();
    this.truthLine.clear();
    this.ghostLine.clear();
    this.lastError = null;
    this.lastTime = this.loop.sim.time;
  }

  private tick(ghost: GhostWorld | null): void {
    const truth = this.loop.sim;
    const t = truth.time;
    if (this.moon) {
      const { xpos, xquat } = truth.bodyPoses();
      this.poseLine.push(t, { xpos: new Float64Array(xpos), xquat: new Float64Array(xquat) });
      this.truthLine.push(t, armSample(truth));
    }
    this.lastError = null;
    if (ghost) {
      this.ghostLine.push(t, armSample(ghost.sim));
      const seen = this.truthLine.read(t - this.delayS);
      const matched = this.ghostLine.read(t - 2 * this.delayS);
      // Only once both reach back far enough: before that the line would compare the wrong moments.
      if (seen && matched && t - 2 * this.delayS >= this.ghostLine.oldest()!.t - 1e-6) this.lastError = ghostError(seen.value, matched.value);
    }
    if (this.listeners.size === 0) return;
    const liveHand = this.liveHand();
    const info: TickInfo = {
      t,
      mode: this.mode,
      truth,
      ghost: ghost?.sim ?? null,
      liveHand,
      liveCommand: this.delayed ? (liveHand ? handToCommand(liveHand) : null) : this.loop.lastCommand,
      error: this.lastError,
    };
    for (const listener of this.listeners) listener(info);
  }
}
