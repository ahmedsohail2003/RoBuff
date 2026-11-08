// The voice source: voice drives the arm from the operator's seat, the same seat the hand and
// the mouse use. It emits a HandState like any source, so the stop latch, the hand workspace
// clamp, the Moon delay line and the ghost all apply to voice exactly as they do to the hand.
//
// It plays a queue of min-jerk steps on simulated time, at a 0.10 m/s peak. A step starts at
// the first poll after it was queued, never back-dated. On a stop it drops the queue and brakes:
// the arm is told to hold the joint angles it has at the latch, not the last command, which the
// servos still lag mid-move (holding the last command let the site creep about 3.6 mm). Its clock
// does not run while stopped, so nothing jumps after Resume.
// When the queue is done it holds the pose (the IK and gravity feedforward keep the arm there).
//
// It reads loop.sim and loop.controller fresh every time: an object spawn swaps both in place.

import { currentGrip } from '../control/grip';
import { operatorSource } from '../delay/dualSim';
import { handToCommand, worldToPalm } from '../control/handMapping';
import type { ControlLoop } from '../control/controlLoop';
import { minJerk } from './pickScript';
import { VOICE_MOTION } from '../control/voiceMotion';
import { GRIPPER_SITE } from '../sim/armXml';
import { JAW_ACTUATOR, type Vec3 } from '../sim/simulation';
import type { HandState, InputSource } from './handState';

export interface VoiceStep {
  name: string;
  /** Gripper site at the end of the move, held through the dwell. */
  waypoint: Vec3;
  /** Grip at the end of the move, ramped over the move time. */
  grip: number;
  moveS: number;
  dwellS: number;
}

export type VoiceState = 'holding' | 'moving' | 'handing-back' | 'handed-back';
export type StepsOutcome = 'done' | 'cancelled';

interface ActiveStep extends VoiceStep {
  from: Vec3;
  fromGrip: number;
  startT: number;
}

interface Batch {
  steps: VoiceStep[];
  label: string;
  resolve: (outcome: StepsOutcome) => void;
}

export interface VoiceSourceOptions {
  /** The source voice took the seat from; it gets the seat back on hand-back. */
  parked: InputSource | null;
  /** Called once the hand-back glide has arrived and the grip agrees: put `parked` back in the seat. */
  onHandBack?: (parked: InputSource | null) => void;
  /** Called on each poll with the simulated time in seconds (the drop watch). */
  onTick?: (t: number) => void;
}

export class VoiceSource implements InputSource {
  readonly kind = 'voice' as const;
  parked: InputSource | null;
  state: VoiceState = 'holding';
  goal: Vec3;
  grip: number;
  label = 'took the arm';
  /** True when the last move was shortened by the workspace clamp. */
  clamped = false;
  /** Name of the step playing, or null. */
  phase: string | null = null;
  onTick: ((t: number) => void) | null;
  private queue: Batch[] = [];
  private batch: Batch | null = null;
  private active: ActiveStep | null = null;
  private lastT: number | null = null;
  private gripAgreed = false;
  private readonly onHandBack: ((parked: InputSource | null) => void) | null;
  private readonly unsubscribe: (() => void) | null;

  constructor(
    private readonly loop: ControlLoop,
    options: VoiceSourceOptions,
  ) {
    this.parked = options.parked;
    this.onHandBack = options.onHandBack ?? null;
    this.onTick = options.onTick ?? null;
    const seed = VoiceSource.seed(loop);
    this.goal = seed.goal;
    this.grip = seed.grip;
    this.unsubscribe =
      loop.stopLatch?.onChange((stopped) => {
        if (!stopped) return;
        this.cancel('stopped');
        this.brake();
      }) ?? null;
  }

  /** Where the arm is being told to be now: the live command, else the controller's target, else the gripper site. */
  static seed(loop: ControlLoop): { goal: Vec3; grip: number } {
    const status = loop.controller.status();
    const live = loop.source ? loop.lastCommand : null;
    const site = loop.sim.getSitePos(GRIPPER_SITE);
    const goal = live?.target ?? status.target ?? site ?? status.smoothed ?? [0, -0.24, 0.08];
    const grip = live?.grip ?? status.grip ?? currentGrip(loop.sim, JAW_ACTUATOR);
    return { goal: [...goal] as Vec3, grip };
  }

  /** True while steps are playing or queued. */
  get busy(): boolean {
    return this.active !== null || this.queue.length > 0 || this.batch !== null;
  }

  /** Seconds left in the steps queued now (0 when holding). */
  remainingS(): number {
    const pending = [...(this.batch && this.active ? this.batch.steps : []), ...this.queue.flatMap((b) => b.steps)];
    return pending.reduce((sum, step) => sum + step.moveS + (Number.isFinite(step.dwellS) ? step.dwellS : 0), this.active ? this.active.moveS + this.active.dwellS : 0);
  }

  /** Queues steps; resolves 'done' after the last dwell, or 'cancelled' on a stop, a reset or a newer hand-back. */
  runSteps(steps: VoiceStep[], label: string): Promise<StepsOutcome> {
    if (this.loop.stopLatch?.stopped) return Promise.resolve('cancelled');
    if (this.state === 'handing-back' || this.state === 'handed-back') this.state = 'holding';
    return new Promise((resolve) => {
      this.queue.push({ steps: steps.map((s) => ({ ...s, waypoint: [...s.waypoint] as Vec3 })), label, resolve });
    });
  }

  /** One straight move to a goal at the voice speed, keeping the grip. */
  moveTo(goal: Vec3, moveS: number, label: string, dwellS = 0): Promise<StepsOutcome> {
    return this.runSteps([{ name: 'move', waypoint: goal, grip: this.endGrip(), moveS, dwellS }], label);
  }

  /** Opens or closes the jaw where the arm is, over 0.4 s plus a short settle. */
  setGrip(grip: number, label: string, dwellS = 0.3): Promise<StepsOutcome> {
    return this.runSteps([{ name: grip >= 0.5 ? 'close' : 'open', waypoint: this.endGoal(), grip, moveS: VOICE_MOTION.gripS, dwellS }], label);
  }

  /** Where the queue ends (the goal when nothing is queued). */
  endGoal(): Vec3 {
    const last = this.queue.at(-1)?.steps.at(-1) ?? (this.active && this.batch ? this.batch.steps.at(-1) ?? this.active : null);
    return [...(last?.waypoint ?? this.goal)] as Vec3;
  }

  endGrip(): number {
    const last = this.queue.at(-1)?.steps.at(-1) ?? (this.active && this.batch ? this.batch.steps.at(-1) ?? this.active : null);
    return last?.grip ?? this.grip;
  }

  /**
   * Gives the arm back: glides to wherever the parked hand or mouse points at 0.10 m/s, keeps
   * the voice grip (when keepGrip: something is held) until the hand's pinch agrees, so an open hand never drops it,
   * then onHandBack puts the parked source back in the seat.
   */
  handBack(keepGrip = true): void {
    this.cancel('handing back');
    this.state = 'handing-back';
    // With nothing in the jaw there is nothing to drop: the hand's grip applies at once.
    this.gripAgreed = !keepGrip;
    this.label = 'handing the arm back';
  }

  /** Drops the queue and holds the last pose sent. */
  cancel(why: string): void {
    const batches = [...(this.batch ? [this.batch] : []), ...this.queue];
    this.queue = [];
    this.batch = null;
    this.active = null;
    this.phase = null;
    if (this.state === 'moving') this.state = 'holding';
    if (batches.length) this.label = why;
    for (const b of batches) b.resolve('cancelled');
  }

  poll(tMs: number): HandState | null {
    const t = tMs / 1000;
    const dt = this.lastT === null ? 0 : Math.min(0.05, Math.max(0, t - this.lastT));
    this.lastT = t;
    this.onTick?.(t);
    if (this.loop.stopLatch?.stopped) {
      // Frozen: nothing queued survives a stop, and the clock does not run.
      if (this.busy) this.cancel('stopped');
      return this.sample(tMs);
    }
    if (this.state === 'handing-back') return this.glideBack(tMs, dt);
    this.advance(t);
    return this.sample(tMs);
  }

  reset(): void {
    this.cancel('reset');
    this.parked?.reset();
    this.lastT = null;
    const site = this.loop.sim.getSitePos(GRIPPER_SITE);
    if (site) this.goal = site;
    this.grip = currentGrip(this.loop.sim, JAW_ACTUATOR);
    if (this.state !== 'handed-back') this.state = 'holding';
    // The last macro's label ("picking it up") must not outlive a reset.
    this.label = 'reset';
  }

  /** The object voice held is gone (a reset or a new object): a stale "picking it up" label goes with it. */
  forgetHold(): void {
    if (this.busy) return;
    this.label = 'holding the arm, nothing in the jaw';
  }

  describe(): Record<string, unknown> {
    return {
      owner: 'voice',
      state: this.state,
      goal: [...this.goal],
      grip: this.grip,
      label: this.label,
      phase: this.phase,
      remainingS: this.remainingS(),
      clamped: this.clamped,
      parkedKind: this.parked?.kind ?? null,
    };
  }

  dispose(): void {
    this.cancel('disposed');
    this.unsubscribe?.();
    this.parked?.dispose();
  }

  /**
   * Holds the arm where it is at the stop: the controller forgets its target and smoothing (so
   * nothing it had in flight comes back after Resume), and each arm servo is told the joint angle
   * measured now, plus the same gravity feedforward the controller adds. The jaw keeps its command,
   * so a held object stays held. Only while voice holds the seat; the hand and mouse keep the latch
   * as it was. In Moon mode the true arm brakes, and the voice goal (the ghost's) stays put.
   */
  private brake(): void {
    if (operatorSource(this.loop) !== this) return;
    const { sim, controller } = this.loop;
    controller.reset();
    const q = sim.getJointPos();
    const bias = controller.useGravityFeedforward ? sim.getArmBiasForces() : [];
    const gain = sim.model.actuator_gainprm as Float64Array;
    sim.setArmCtrl(q.map((value, i) => value + (bias[i] ?? 0) / gain[10 * i]!));
    if (this.loop.source === this) {
      const site = sim.getSitePos(GRIPPER_SITE);
      if (site) this.goal = site;
    }
  }

  private sample(tMs: number): HandState {
    return { palm: worldToPalm(this.goal), pinch: this.grip, confidence: 1, tMs };
  }

  private advance(t: number): void {
    for (let guard = 0; guard < 64; guard++) {
      if (!this.active) {
        if (!this.batch || this.batch.steps.length === 0) {
          if (this.batch) {
            const done = this.batch;
            this.batch = null;
            done.resolve('done');
          }
          const next = this.queue.shift();
          if (!next) {
            if (this.state === 'moving') this.state = 'holding';
            this.phase = null;
            return;
          }
          this.batch = next;
          this.label = next.label;
          this.clamped = false;
        }
        const step = this.batch.steps.shift()!;
        this.active = { ...step, from: [...this.goal] as Vec3, fromGrip: this.grip, startT: t };
        this.state = 'moving';
        this.phase = step.name;
      }
      const step = this.active;
      const local = t - step.startT;
      const s = step.moveS > 0 ? minJerk(local / step.moveS) : 1;
      this.goal = [0, 1, 2].map((k) => step.from[k]! + (step.waypoint[k]! - step.from[k]!) * s) as Vec3;
      this.grip = step.fromGrip + (step.grip - step.fromGrip) * s;
      if (local < step.moveS + step.dwellS) return;
      // This step is over: the next one starts now, from exactly where this one ended.
      this.goal = [...step.waypoint] as Vec3;
      this.grip = step.grip;
      this.active = null;
    }
  }

  private glideBack(tMs: number, dt: number): HandState {
    const hand = this.parked?.poll(tMs) ?? null;
    const command = hand ? handToCommand(hand) : null;
    if (!command) {
      this.label = 'show your hand or move the mouse to take the arm back';
      return this.sample(tMs);
    }
    this.label = 'handing the arm back';
    const step = VOICE_MOTION.handbackSpeed * dt;
    const d: Vec3 = [command.target[0] - this.goal[0], command.target[1] - this.goal[1], command.target[2] - this.goal[2]];
    const dist = Math.hypot(...d);
    if (dist <= step || dist < 1e-9) this.goal = [...command.target] as Vec3;
    else this.goal = this.goal.map((v, k) => v + (d[k]! / dist) * step) as Vec3;
    if (!this.gripAgreed && Math.abs(command.grip - this.grip) < VOICE_MOTION.gripMatch) this.gripAgreed = true;
    if (this.gripAgreed) this.grip = command.grip;
    const left = Math.hypot(command.target[0] - this.goal[0], command.target[1] - this.goal[1], command.target[2] - this.goal[2]);
    if (this.gripAgreed && left < VOICE_MOTION.handbackDoneM) {
      this.state = 'handed-back';
      this.label = 'gave the arm back';
      this.onHandBack?.(this.parked);
    }
    return this.sample(tMs);
  }
}

/** The hand, mouse or synthetic source behind the seat: unwraps the Moon delay and a voice takeover. */
export function handSeat(loop: { source: InputSource | null }): InputSource | null {
  const seat = operatorSource(loop);
  return seat instanceof VoiceSource ? seat.parked : seat;
}
