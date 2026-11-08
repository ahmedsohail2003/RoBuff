import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CSV_COLUMNS, toCsv, trialRow, type SessionSettings } from './logger';
import { ReversalCounter, trialOrder, type TrialOutcome } from './protocol';

/** The 33 columns, in order, as PLAN.md §4 M4 step 6 lists them. */
const PLAN_COLUMNS =
  'session_id, trial_idx, block, condition, practice, excluded, exclude_reason, operator, input_source, delay_oneway_ms, gravity_mps2, rock_spec_id, rock_seed, rock_size_mm, rock_mass_true_g, rock_mass_ghost_g, friction_true, friction_ghost, cutoff_s, t_go_iso, completion_s, success, reach_s, grasp_s, grasp_attempts, drops, reversals, pauses, max_ghost_err_mm, mean_ghost_err_mm, hand_lost_ms, render_fps_median, build_id';

const SETTINGS: SessionSettings = {
  session_id: 'unit',
  operator: 'unit-test',
  delay_oneway_ms: 1280,
  rock_spec_id: 'arena-block-30mm',
  rock_seed: 0,
  rock_size_mm: 30,
  rock_mass_true_g: 62.1,
  rock_mass_ghost_g: 43.2,
  friction_true: 0.6,
  friction_ghost: 0.8,
  cutoff_s: 90,
  build_id: 'unit',
};

function outcome(success: boolean): TrialOutcome {
  return {
    success,
    completion_s: success ? 12.5 : null,
    reach_s: success ? 4.25 : null,
    grasp_s: success ? 6 : null,
    grasp_attempts: 2,
    drops: 1,
    reversals: 7,
    pauses: 3,
    max_ghost_err_mm: 4.5,
    mean_ghost_err_mm: 1.25,
    hand_lost_ms: 120,
    render_fps_median: 59.9,
    excluded: false,
    exclude_reason: '',
    ran_s: success ? 14.5 : 90,
  };
}

describe('trial logger CSV', () => {
  it('the header is these 33 columns in this order, and matches the gate scorer fixture', () => {
    const header = toCsv([]).trim();
    expect(CSV_COLUMNS.length).toBe(33);
    expect(header).toBe(PLAN_COLUMNS.split(', ').join(','));
    const fixture = readFileSync(path.resolve(import.meta.dirname, '../../../scripts/fixtures/gate-16.csv'), 'utf8').split(/\r?\n/)[0];
    expect(header).toBe(fixture);
  });

  it('a failure leaves completion_s, reach_s and grasp_s empty (never the cutoff)', () => {
    const context = { trial_idx: 7, spec: { condition: 'ghost_off' as const, practice: false, block: '1' }, input_source: 'webcam', gravity_mps2: 1.62, t_go_iso: '2026-11-07T23:00:00.000Z' };
    const failed = trialRow(SETTINGS, context, outcome(false));
    expect(failed.success).toBe('0');
    expect(failed.completion_s).toBe('');
    expect(failed.reach_s).toBe('');
    expect(failed.grasp_s).toBe('');
    expect(Object.values(failed)).not.toContain('90.0');
    expect(failed.cutoff_s).toBe('90');
    // Ghost error columns only for ghost_on.
    expect(failed.max_ghost_err_mm).toBe('');
    const ok = trialRow(SETTINGS, { ...context, spec: { condition: 'ghost_on', practice: false, block: '1' } }, outcome(true));
    expect([ok.success, ok.completion_s, ok.reach_s, ok.grasp_s, ok.max_ghost_err_mm, ok.mean_ghost_err_mm]).toEqual(['1', '12.5', '4.25', '6', '4.5', '1.25']);
    const direct = trialRow(SETTINGS, { ...context, spec: { condition: 'direct', practice: true, block: 'warmup' } }, outcome(true));
    expect(direct.delay_oneway_ms).toBe('0');
    const csv = toCsv([failed, ok]).trim().split('\n');
    expect(csv).toHaveLength(3);
    expect(csv[1]!.split(',')).toHaveLength(33);
  });

  it('quotes a cell with a comma', () => {
    const context = { trial_idx: 1, spec: { condition: 'direct' as const, practice: true, block: 'warmup' }, input_source: 'mouse', gravity_mps2: 1.62, t_go_iso: 'x' };
    const row = trialRow(SETTINGS, context, { ...outcome(false), excluded: true, exclude_reason: 'hand lost, 5.2 s' });
    expect(toCsv([row])).toContain('"hand lost, 5.2 s"');
  });
});

describe('trial protocol', () => {
  it('orders 4 direct warm-ups, 2 practice per condition, then off-on-on-off blocks', () => {
    const order = trialOrder(3);
    expect(order).toHaveLength(4 + 4 + 12);
    expect(order.slice(0, 4).every((t) => t.condition === 'direct' && t.practice && t.block === 'warmup')).toBe(true);
    expect(order.slice(4, 8).map((t) => t.condition)).toEqual(['ghost_off', 'ghost_on', 'ghost_off', 'ghost_on']);
    expect(order.slice(8).map((t) => t.condition)).toEqual(Array.from({ length: 3 }, () => ['ghost_off', 'ghost_on', 'ghost_on', 'ghost_off']).flat());
    expect(order.slice(8).every((t) => !t.practice)).toBe(true);
    expect(trialOrder(4)).toHaveLength(24);
  });

  it('counts a reversal only after 10 mm of travel each way', () => {
    const r = new ReversalCounter(0.01);
    for (const v of [0, 0.005, 0.02, 0.015, 0.012, 0.03, 0.0, 0.004, -0.001]) r.add(v);
    // 0 -> 0.02 (up), dips 8 mm (no), up to 0.03, down to 0.0 (1), up 4 mm (no).
    expect(r.count).toBe(1);
  });
});
