// One object request, end to end: object brain -> cheap guardrail -> spawn in the live
// scene -> settle on the pad -> headless lift test -> verdict. Each stage is reported as it
// runs, so the panel can tick it. The spec comes from the object brain: Gemini through the
// key server when it is live, otherwise the offline keyword mock and presets, with no network call.

import { approximationLine } from '../objects/approximation';
import { proveLift } from '../objects/lift';
import { validate } from '../objects/guardrail';
import { objectBrain, type ObjectBrain, type SpecResult } from '../objects/objectBrain';
import { receiptSummary, type Receipt, type ReceiptStep } from '../objects/receipt';
import { withSettleStep } from '../objects/settle';
import { say } from '../objects/format';
import { LOW_GRAVITY_NOTE, LOW_GRAVITY_NOTE_BELOW } from './gravity';
import { ArmLiftTester, type LiftRun } from './liftTester';
import type { Mujoco } from './mujocoRuntime';
import { CUBE_SLOT_BODY, type ObjectSlot, type SpawnReport } from './objectSlot';
import { setRockReturn } from './rockReturn';

export type StageState = 'pending' | 'running' | 'ok' | 'note' | 'adjusted' | 'refused';

export interface Stage {
  code: string;
  state: StageState;
  text: string;
}

export interface RequestProgress {
  text: string;
  source: SpecResult['source'];
  matched: string[];
  stages: Stage[];
  receipt: Receipt | null;
  /** Null until the request is decided. */
  verdict: Receipt['verdict'] | null;
  done: boolean;
}

export interface RequestOutcome {
  text: string;
  source: SpecResult['source'];
  matched: string[];
  spawned: boolean;
  receipt: Receipt;
  stages: Stage[];
  spawn: Omit<SpawnReport, 'rest'> | null;
  runs: LiftRun[];
  /** Wall-clock ms: recompile of the live scene, settle, and the whole lift test. */
  timings: { spec_ms: number; recompile_ms: number | null; swap_ms: number | null; settle_ms: number | null; lift_ms: number | null; total_ms: number };
  /** Degrees the live object was turned on the pad to match the passing lift attempt. */
  live_turn_deg: number | null;
}

export interface ObjectRequestHooks {
  /** The slot's body changed: draw this receipt's mesh on it, or the cube again for null. */
  onOccupant(receipt: Receipt | null): void;
}

const CHECK_TICK_MS = 70;
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function stateOf(step: ReceiptStep): StageState {
  if (step.action === 'refused') return 'refused';
  if (step.action === 'rescaled' || step.action === 'clamped') return 'adjusted';
  if (step.action === 'note' || step.action === 'pending') return 'note';
  return 'ok';
}

/** A request's receipt as plain JSON for the debug hook: numbers, messages, and stage list. */
export function outcomeSummary(outcome: RequestOutcome): Record<string, unknown> {
  return { ...outcome, receipt: receiptSummary(outcome.receipt) };
}

export class ObjectRequests {
  busy = false;
  last: RequestOutcome | null = null;
  /** The receipt now in the slot, or null while the cube is there. */
  private occupant: Receipt | null = null;
  /** Set by putRockBack: a later failed request then leaves the rock, not the object before it. */
  private rockBack = false;

  constructor(
    private readonly mujoco: Mujoco,
    readonly slot: ObjectSlot,
    private readonly hooks: ObjectRequestHooks,
    private readonly brain: ObjectBrain = objectBrain,
  ) {
    setRockReturn(() => this.putRockBack());
  }

  /**
   * Takes the spawned object out and puts the 30 mm test rock (the scene's own cube slot)
   * back, for the delay modes. False while a request is running; true when the rock is there.
   */
  putRockBack(): boolean {
    if (this.busy) return false;
    if (this.occupant === null && this.slot.bodyName === CUBE_SLOT_BODY) return true;
    this.slot.restoreCube();
    this.occupant = null;
    this.rockBack = true;
    this.hooks.onOccupant(null);
    return true;
  }

  async run(text: string, onProgress: (progress: RequestProgress) => void = () => {}): Promise<RequestOutcome> {
    if (this.busy) throw new Error('another object request is still running');
    this.busy = true;
    try {
      return await this.runInner(text, onProgress);
    } finally {
      this.busy = false;
    }
  }

  private async runInner(text: string, onProgress: (progress: RequestProgress) => void): Promise<RequestOutcome> {
    const t0 = performance.now();
    const mock = await this.brain.specFor(text);
    const stages: Stage[] = [];
    const progress: RequestProgress = { text, source: mock.source, matched: mock.matched, stages, receipt: null, verdict: null, done: false };
    const emit = (): void => onProgress({ ...progress, stages: stages.map((s) => ({ ...s })) });
    const push = (stage: Stage): Stage => {
      stages.push(stage);
      emit();
      return stage;
    };

    if (mock.source === 'gemini') {
      const closest = approximationLine(mock.spec);
      push({ code: 'REQUEST', state: closest ? 'note' : 'ok', text: `Gemini 3.8 Flash wrote the spec in ${say(mock.latency_ms)} ms. ${closest ? `${closest} ` : ''}${mock.spec.why}` });
    } else {
      const matched = mock.matched.length ? mock.matched.join(', ') : 'no keywords, so defaults';
      push({ code: 'REQUEST', state: mock.note ? 'note' : 'ok', text: `${mock.note ? `${mock.note} ` : ''}Offline mock read the request (no Gemini call): ${matched}. ${mock.spec.why}` });
    }

    const gravity = Math.abs((this.slot.sim.model.opt.gravity as Float64Array)[2]!);
    let receipt = validate(mock.spec, { gravity_m_s2: gravity });
    progress.receipt = receipt;
    const checks = receipt.steps.filter((s) => s.code !== 'LIFT_NOT_RUN');
    const stageOf = new Map<string, Stage>();
    for (const step of checks) {
      await wait(CHECK_TICK_MS);
      stageOf.set(step.code, push({ code: step.code, state: stateOf(step), text: step.message }));
    }
    if (gravity < LOW_GRAVITY_NOTE_BELOW) push({ code: 'LOW_GRAVITY', state: 'note', text: LOW_GRAVITY_NOTE });

    const timings: RequestOutcome['timings'] = { spec_ms: mock.latency_ms, recompile_ms: null, swap_ms: null, settle_ms: null, lift_ms: null, total_ms: 0 };
    const finish = (spawned: boolean, spawn: SpawnReport | null, runs: LiftRun[], liveTurn: number | null): RequestOutcome => {
      timings.total_ms = performance.now() - t0;
      progress.verdict = receipt.verdict;
      progress.receipt = receipt;
      progress.done = true;
      emit();
      let spawnInfo: RequestOutcome['spawn'] = null;
      if (spawn) {
        const { rest: _rest, ...withoutRest } = spawn;
        void _rest;
        spawnInfo = withoutRest;
      }
      const outcome: RequestOutcome = { text, source: mock.source, matched: mock.matched, spawned, receipt, stages: stages.map((s) => ({ ...s })), spawn: spawnInfo, runs, timings, live_turn_deg: liveTurn };
      this.last = outcome;
      return outcome;
    };

    if (receipt.verdict === 'REFUSED') {
      const reason = receipt.steps.find((s) => s.action === 'refused');
      push({ code: 'NOT_SPAWNED', state: 'refused', text: `Not spawned. ${reason ? reason.message : 'A check refused it.'} The lift test was not run, because a check above already ruled it out.` });
      return finish(false, null, [], null);
    }

    // Spawn: recompile the live scene with the object in the slot, then let it settle.
    const recompile = push({ code: 'RECOMPILE', state: 'running', text: 'Recompiling the live scene with the object as the last body...' });
    await wait(0);
    const spawn = this.slot.spawn(receipt);
    this.occupant = receipt;
    this.hooks.onOccupant(receipt);
    timings.recompile_ms = spawn.compile_ms;
    timings.swap_ms = spawn.swap_ms;
    timings.settle_ms = spawn.settle_ms;
    recompile.state = 'ok';
    recompile.text = `Recompiled the live scene with it in the object slot in ${say(spawn.compile_ms)} ms, kept the arm's pose, speed and commands, and deleted the old model.`;
    const hull = stageOf.get('HULL_OK');
    if (hull && spawn.hullStep) {
      hull.text = spawn.hullStep.message;
      receipt = { ...receipt, steps: receipt.steps.map((s) => (s.code === 'HULL_OK' ? spawn.hullStep! : s)) };
    }
    emit();
    receipt = withSettleStep(receipt, spawn.settleStep, spawn.rest);
    push({ code: spawn.settleStep.code, state: spawn.settled ? 'ok' : 'note', text: `${spawn.settleStep.message} (on the pad, ${say(spawn.settle_sim_s)} simulated seconds)` });

    // The only proof: the simulated lift test on a second MjData of this same model.
    const lift = push({ code: 'LIFT_TEST', state: 'running', text: 'Simulated lift test running: attempt 1 of up to 3...' });
    const tester = new ArmLiftTester(this.mujoco, {
      live: () => this.slot.sim,
      bodyName: this.slot.bodyName,
      onAttempt: (n) => {
        lift.text = `Simulated lift test running: attempt ${n} of up to 3...`;
        emit();
      },
    });
    const liftStart = performance.now();
    receipt = await proveLift(receipt, tester);
    timings.lift_ms = performance.now() - liftStart;
    const outcomeStep = receipt.steps[receipt.steps.length - 1]!;
    const attempts = receipt.lift.attempts
      .map((a, i) => `try ${i + 1} at ${say(a.yaw_deg)} degrees: rose ${say(a.rise_mm)} mm, held ${(a.hold_s ?? 0).toFixed(1)} s, ${say(a.wall_ms ?? 0)} ms`)
      .join('; ');
    lift.code = outcomeStep.code;
    lift.state = receipt.lift.status === 'passed' ? 'ok' : 'refused';
    lift.text = `${outcomeStep.message} (${attempts}.)`;
    emit();

    let liveTurn: number | null = null;
    if (receipt.lift.status === 'passed') {
      // Turn the live object the way the passing attempt did, so the live arm meets it the same way.
      const run = tester.runs[tester.runs.length - 1]!;
      liveTurn = run.turn_deg;
      if (Math.abs(run.turn_deg) >= 0.5) {
        this.slot.turnObject((run.turn_deg * Math.PI) / 180);
        push({ code: 'TURNED', state: 'note', text: `I turned it ${say(run.turn_deg)} degrees on the pad, as in the passing lift test, so my jaw meets its ${say(run.width_mm)} millimetre side.` });
      }
      this.slot.receipt = receipt;
      this.occupant = receipt;
      this.rockBack = false;
    } else {
      // A failed lift is a refusal: take it out of the scene again.
      this.restorePrevious(receipt);
      push({ code: 'REMOVED', state: 'refused', text: 'It failed the lift test, so I took it out of the scene again.' });
    }
    return finish(receipt.lift.status === 'passed', spawn, tester.runs, liveTurn);
  }

  /**
   * The guardrail's friction line for the last request, re-run at another gravity: the same
   * spec through validate, so size and mass come out the same and only the friction step changes.
   * Null before any request.
   */
  frictionAt(gravity_m_s2: number): { code: 'FRICTION_OK' | 'SLIPS'; ok: boolean; text: string; gravity_m_s2: number; required_mu: number | null; mu: number | null } | null {
    const last = this.last;
    if (!last) return null;
    const checked = validate(last.receipt.spec, { gravity_m_s2 });
    const step = checked.steps.find((s) => s.code === 'FRICTION_OK' || s.code === 'SLIPS');
    if (!step) return null;
    return { code: step.code as 'FRICTION_OK' | 'SLIPS', ok: step.ok, text: step.message, gravity_m_s2, required_mu: step.limit, mu: step.measured };
  }

  private restorePrevious(failed: Receipt): void {
    const previous = this.last?.spawned && !this.rockBack ? this.last.receipt : null;
    if (previous && previous !== failed) {
      this.slot.spawn(previous);
      this.occupant = previous;
    } else {
      this.slot.restoreCube();
      this.occupant = null;
    }
    this.hooks.onOccupant(this.occupant);
  }
}
