// The trial logger: one CSV row per trial in the 33 columns the gate scorer reads
// (scripts/trials-verdict.mjs), in that exact order, plus a sidecar JSON with the settings
// and the pass rule. Real trials only: nothing here makes up a row.

import type { Condition, TrialOutcome, TrialSpec } from './protocol';
import { PROTOCOL } from './protocol';

export const CSV_COLUMNS = [
  'session_id',
  'trial_idx',
  'block',
  'condition',
  'practice',
  'excluded',
  'exclude_reason',
  'operator',
  'input_source',
  'delay_oneway_ms',
  'gravity_mps2',
  'rock_spec_id',
  'rock_seed',
  'rock_size_mm',
  'rock_mass_true_g',
  'rock_mass_ghost_g',
  'friction_true',
  'friction_ghost',
  'cutoff_s',
  't_go_iso',
  'completion_s',
  'success',
  'reach_s',
  'grasp_s',
  'grasp_attempts',
  'drops',
  'reversals',
  'pauses',
  'max_ghost_err_mm',
  'mean_ghost_err_mm',
  'hand_lost_ms',
  'render_fps_median',
  'build_id',
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];
export type TrialRow = Record<CsvColumn, string>;

/** Settings that are the same for every row of a session. */
export interface SessionSettings {
  session_id: string;
  operator: string;
  delay_oneway_ms: number;
  rock_spec_id: string;
  rock_seed: number;
  rock_size_mm: number;
  rock_mass_true_g: number;
  rock_mass_ghost_g: number;
  friction_true: number;
  friction_ghost: number;
  cutoff_s: number;
  build_id: string;
}

export interface TrialContext {
  trial_idx: number;
  spec: TrialSpec;
  input_source: string;
  gravity_mps2: number;
  t_go_iso: string;
}

function num(value: number | null, digits: number): string {
  return value === null || !Number.isFinite(value) ? '' : String(Number(value.toFixed(digits)));
}

/**
 * One row. A failed trial leaves completion_s, reach_s and grasp_s empty, never the cutoff.
 * The ghost error columns are filled only for ghost_on trials.
 */
export function trialRow(settings: SessionSettings, context: TrialContext, outcome: TrialOutcome): TrialRow {
  const condition: Condition = context.spec.condition;
  const ghost = condition === 'ghost_on';
  return {
    session_id: settings.session_id,
    trial_idx: String(context.trial_idx),
    block: context.spec.block,
    condition,
    practice: context.spec.practice ? '1' : '0',
    excluded: outcome.excluded ? '1' : '0',
    exclude_reason: outcome.exclude_reason,
    operator: settings.operator,
    input_source: context.input_source,
    delay_oneway_ms: condition === 'direct' ? '0' : String(settings.delay_oneway_ms),
    gravity_mps2: num(context.gravity_mps2, 6),
    rock_spec_id: settings.rock_spec_id,
    rock_seed: String(settings.rock_seed),
    rock_size_mm: num(settings.rock_size_mm, 1),
    rock_mass_true_g: num(settings.rock_mass_true_g, 1),
    rock_mass_ghost_g: num(settings.rock_mass_ghost_g, 1),
    friction_true: num(settings.friction_true, 3),
    friction_ghost: num(settings.friction_ghost, 3),
    cutoff_s: num(settings.cutoff_s, 1),
    t_go_iso: context.t_go_iso,
    completion_s: outcome.success ? num(outcome.completion_s, 3) : '',
    success: outcome.success ? '1' : '0',
    reach_s: outcome.success ? num(outcome.reach_s, 3) : '',
    grasp_s: outcome.success ? num(outcome.grasp_s, 3) : '',
    grasp_attempts: String(outcome.grasp_attempts),
    drops: String(outcome.drops),
    reversals: String(outcome.reversals),
    pauses: String(outcome.pauses),
    max_ghost_err_mm: ghost ? num(outcome.max_ghost_err_mm, 2) : '',
    mean_ghost_err_mm: ghost ? num(outcome.mean_ghost_err_mm, 2) : '',
    hand_lost_ms: num(outcome.hand_lost_ms, 0),
    render_fps_median: num(outcome.render_fps_median, 1),
    build_id: settings.build_id,
  };
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: readonly TrialRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) lines.push(CSV_COLUMNS.map((column) => csvCell(row[column])).join(','));
  return lines.join('\n') + '\n';
}

/** The pass rule, verbatim from PLAN.md §4 M4c (also under "## Gate rules" in PROGRESS.md). */
export const PASS_RULE =
  'GO if median(on) ≤ 0.75 × median(off) and successes(on) ≥ successes(off) → A leads the pitch. AMBIGUOUS (ratio 0.75-0.90, successes not lower) → the ghost stays a setting and a beat, B + C lead, real numbers shown. NO-GO (ratio > 0.90 or fewer successes) → B + C lead, delay as a setting, the results beat says so. Sanity check: if median(off) < 1.5 × the direct median the task is too easy; make it harder once (smaller rock or tighter placement) and re-run; if delay still barely hurts, go to B + C. The 0.75 is a judgment call between Richter\'s 0.81 at 1 s and Sheridan\'s implied 0.40-0.67; it does not change after the data.';

export function sidecar(settings: SessionSettings, order: readonly TrialSpec[], rows: readonly TrialRow[]): Record<string, unknown> {
  return {
    session_id: settings.session_id,
    written_at_iso: new Date().toISOString(),
    settings,
    protocol: { ...PROTOCOL, order: order.map((spec, i) => ({ trial_idx: i + 1, ...spec })) },
    stable_lift: `rock lowest point >= ${PROTOCOL.liftMinM * 1000} mm above the floor with both jaw pads touching, ${PROTOCOL.liftHoldS} s unbroken, on the truth arm's simulated clock`,
    pass_rule: PASS_RULE,
    columns: CSV_COLUMNS,
    rows: rows.length,
    note: 'Simulation only: both arms are MuJoCo simulations; the delay is a constant modelled 1.28 s each way. Mouse and synthetic rows check the logger and are never gate data.',
  };
}

export function csvFileName(sessionId: string): string {
  return `ghost-gate-${sessionId}.csv`;
}

/** Session id from the wall clock: s20261107-193005. */
export function sessionIdAt(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `s${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}
