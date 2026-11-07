// Rule-boundary tests for the ghost gate scorer (scripts/lib/gate.mjs, PLAN.md §4 M4c).
// They live in the app so `npm test` runs them; the scorer itself is plain Node at the repo root.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COLUMNS,
  checkHeader,
  decide,
  median,
  pairWins,
  parseCsv,
  readTrials,
  sanity,
  signTestP,
  summarize,
  type Trial,
} from '../../../scripts/lib/gate.mjs';

const FIXTURE = path.resolve(import.meta.dirname, '../../../scripts/fixtures/gate-16.csv');

/** The 33 columns exactly as PLAN.md §4 M4 step 6 lists them. */
const PLAN_COLUMNS =
  'session_id, trial_idx, block, condition, practice, excluded, exclude_reason, operator, input_source, delay_oneway_ms, gravity_mps2, rock_spec_id, rock_seed, rock_size_mm, rock_mass_true_g, rock_mass_ghost_g, friction_true, friction_ghost, cutoff_s, t_go_iso, completion_s, success, reach_s, grasp_s, grasp_attempts, drops, reversals, pauses, max_ghost_err_mm, mean_ghost_err_mm, hand_lost_ms, render_fps_median, build_id'.split(
    ', ',
  );

let nextIdx = 1;
function trial(condition: Trial['condition'], completion: number | null, extra: Partial<Trial> = {}): Trial {
  const idx = nextIdx++;
  return {
    rowNo: idx,
    trialIdx: idx,
    block: '1',
    condition,
    practice: false,
    excluded: false,
    excludeReason: '',
    operator: 'ahmed',
    inputSource: 'webcam',
    delayOnewayMs: condition === 'direct' ? 0 : 1280,
    success: completion !== null,
    completionS: completion,
    reachS: completion === null ? null : completion / 3,
    graspS: completion === null ? null : completion / 2,
    ...extra,
  };
}

const rule = (medianOn: number | null, medianOff: number | null, successesOn = 6, successesOff = 6) =>
  decide({ medianOn, medianOff, successesOn, successesOff });

describe('ghost gate columns', () => {
  it('has the 33 PLAN columns in order', () => {
    expect(PLAN_COLUMNS).toHaveLength(33);
    expect([...COLUMNS]).toEqual(PLAN_COLUMNS);
    expect(checkHeader(PLAN_COLUMNS).ok).toBe(true);
  });

  it('rejects a missing, extra or reordered column', () => {
    expect(checkHeader(PLAN_COLUMNS.slice(1)).ok).toBe(false);
    expect(checkHeader([...PLAN_COLUMNS, 'notes']).ok).toBe(false);
    const swapped = [...PLAN_COLUMNS];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    const r = checkHeader(swapped);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain('column 1 is trial_idx');
  });

  it('parses quoted fields with commas and doubled quotes', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ]);
  });
});

describe('pass rule boundaries (fixed before the data)', () => {
  it('ratio exactly 0.75 with equal successes is GO', () => {
    const r = rule(30, 40);
    expect(r.ratio).toBeCloseTo(0.75, 12);
    expect(r.verdict).toBe('GO');
  });

  it('ratio just above 0.75 is AMBIGUOUS', () => {
    expect(rule(30.01, 40).verdict).toBe('AMBIGUOUS');
  });

  it('ratio exactly 0.90 is AMBIGUOUS, just above is NO-GO', () => {
    expect(rule(36, 40).verdict).toBe('AMBIGUOUS');
    expect(rule(36.01, 40).verdict).toBe('NO-GO');
  });

  it('equal successes do not block GO', () => {
    expect(rule(20, 40, 5, 5).verdict).toBe('GO');
  });

  it('fewer successes with the ghost is NO-GO at any ratio', () => {
    expect(rule(10, 40, 5, 6).verdict).toBe('NO-GO');
    expect(rule(34, 40, 5, 6).verdict).toBe('NO-GO');
    expect(rule(10, 40, 5, 6).reason).toContain('fewer successes');
  });

  it('more successes with the ghost keeps the ratio decision', () => {
    expect(rule(34, 40, 6, 5).verdict).toBe('AMBIGUOUS');
    expect(rule(38, 40, 6, 5).verdict).toBe('NO-GO');
  });

  it('a median not reached decides on the side it falls', () => {
    expect(rule(30, Infinity).verdict).toBe('GO');
    expect(rule(Infinity, 30).verdict).toBe('NO-GO');
    expect(rule(Infinity, Infinity).verdict).toBe('NO-GO');
    expect(rule(null, 30).verdict).toBe('NO-GO');
  });
});

describe('sanity check (too easy)', () => {
  it('median(off) exactly 1.5 x direct passes, just under is too easy', () => {
    expect(sanity({ medianOff: 15, medianDirect: 10 }).status).toBe('ok');
    expect(sanity({ medianOff: 14.9, medianDirect: 10 }).status).toBe('too-easy');
    expect(sanity({ medianOff: 14.9, medianDirect: 10 }).reason).toContain('make it harder once');
  });

  it('is not checked without a direct baseline', () => {
    expect(sanity({ medianOff: 20, medianDirect: null }).status).toBe('not-checked');
  });

  it('summarize flags a too-easy session from the trials', () => {
    const t = [
      ...[8, 9, 10, 11].map((c) => trial('direct', c, { practice: true })),
      ...[12, 13, 14].map((c) => trial('ghost_off', c)),
      ...[9, 10, 11].map((c) => trial('ghost_on', c)),
    ];
    const s = summarize(t);
    expect(s.direct.medianCompletion).toBe(9.5);
    expect(s.sanity.status).toBe('too-easy');
  });
});

describe('medians, pairs and filtering', () => {
  it('ranks failures slowest, and half failures means not reached', () => {
    expect(median([3, Infinity, 1])).toBe(3);
    expect(median([1, 2, Infinity, Infinity])).toBe(Infinity);
    expect(median([])).toBeNull();
  });

  it('sign test p matches the exact binomial', () => {
    expect(signTestP(5, 1)).toBeCloseTo(14 / 64, 12);
    expect(signTestP(8, 0)).toBeCloseTo(2 / 256, 12);
    expect(signTestP(3, 3)).toBe(1);
    expect(signTestP(0, 0)).toBeNull();
  });

  it('pairs on with off inside each block and drops ties from the test', () => {
    const t = [
      trial('ghost_off', 30, { block: 'A' }),
      trial('ghost_on', 20, { block: 'A' }),
      trial('ghost_on', null, { block: 'B' }),
      trial('ghost_off', null, { block: 'B' }),
      trial('ghost_off', 25, { block: 'C' }),
    ];
    const p = pairWins(t);
    expect(p).toMatchObject({ wins: 1, losses: 0, ties: 1, unpaired: 1 });
  });

  it('drops practice and excluded rows from the comparison', () => {
    const t = [
      trial('ghost_off', 40),
      trial('ghost_off', 2, { practice: true }),
      trial('ghost_on', 1, { excluded: true, excludeReason: 'hand lost > 5 s' }),
      trial('ghost_on', 28),
    ];
    const s = summarize(t);
    expect(s.countedN).toBe(2);
    expect(s.practiceDropped).toBe(1);
    expect(s.excludedDropped).toBe(1);
    expect(s.rule.ratio).toBeCloseTo(0.7, 12);
    expect(s.rule.verdict).toBe('GO');
    expect(s.gateData).toBe(false); // 2 rows, under the 12 the gate needs
  });
});

describe('the 16-row fixture', () => {
  it('scores to the numbers worked out by hand', () => {
    const { trials, warnings, rowCount } = readTrials(readFileSync(FIXTURE, 'utf8'));
    expect(rowCount).toBe(16);
    expect(warnings).toEqual([]);
    const s = summarize(trials);
    expect(s.countedN).toBe(12);
    expect(s.off).toMatchObject({ n: 6, successes: 5 });
    expect(s.on).toMatchObject({ n: 6, successes: 6 });
    expect(s.off.medianCompletion).toBeCloseTo(30.2, 9);
    expect(s.on.medianCompletion).toBeCloseTo(24.85, 9);
    expect(s.direct.medianCompletion).toBeCloseTo(8.45, 9);
    expect(s.pairs).toMatchObject({ wins: 5, losses: 1, ties: 0 });
    expect(s.rule.verdict).toBe('AMBIGUOUS');
    expect(s.sanity.status).toBe('ok');
    expect(s.gateData).toBe(false); // synthetic input, operator "fixture"
  });
});
