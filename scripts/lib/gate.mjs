// Ghost gate scoring, shared by scripts/trials-verdict.mjs and scripts/results-table.mjs.
// Pure functions only: no file or network access, so the unit tests can call them directly.
//
// The pass rule is fixed before any trial (PLAN.md §4 M4c, copied into PROGRESS.md at 17:42 EST
// on 2026-11-07). Definitions this file adds, also fixed before any trial:
// - Counted rows: condition ghost_off or ghost_on, practice 0, excluded 0.
// - Direct baseline: condition direct, excluded 0, practice either way (the protocol logs its
//   4 direct warm-ups with practice=1; they are the no-delay baseline).
// - Median completion: over every counted trial of a condition, a failure ranked slower than any
//   success (as if it took forever). If half or more of a condition failed, its median is
//   "not reached" (Infinity). The median over successes only is reported too, never used to decide.
// - Pair wins: within each block, the k-th ghost_on trial is paired with the k-th ghost_off trial
//   in trial order; on wins when it finished faster (a failure is slowest). Ties are left out of
//   the exact two-sided sign test. Reported, never used to decide.

/** The 33 trial logger columns, in the logged order (PLAN.md §4 M4 step 6). */
export const COLUMNS = Object.freeze([
  'session_id', 'trial_idx', 'block', 'condition', 'practice', 'excluded', 'exclude_reason',
  'operator', 'input_source', 'delay_oneway_ms', 'gravity_mps2', 'rock_spec_id', 'rock_seed',
  'rock_size_mm', 'rock_mass_true_g', 'rock_mass_ghost_g', 'friction_true', 'friction_ghost',
  'cutoff_s', 't_go_iso', 'completion_s', 'success', 'reach_s', 'grasp_s', 'grasp_attempts',
  'drops', 'reversals', 'pauses', 'max_ghost_err_mm', 'mean_ghost_err_mm', 'hand_lost_ms',
  'render_fps_median', 'build_id',
]);

export const CONDITIONS = Object.freeze(['direct', 'ghost_off', 'ghost_on']);

/** Thresholds of the pass rule. They do not change after the data. */
export const RULE = Object.freeze({ goRatio: 0.75, ambiguousRatio: 0.9, sanityFactor: 1.5, gateMinRows: 12 });

/** Ratios are compared with this tolerance so that 30/40 counts as exactly 0.75. */
const EPS = 1e-9;

/** The pass rule, verbatim from PLAN.md §4 M4c. */
export const PASS_RULE_TEXT =
  'GO if median(on) ≤ 0.75 × median(off) and successes(on) ≥ successes(off) → A leads the pitch. ' +
  'AMBIGUOUS (ratio 0.75-0.90, successes not lower) → the ghost stays a setting and a beat, B + C lead, real numbers shown. ' +
  'NO-GO (ratio > 0.90 or fewer successes) → B + C lead, delay as a setting, the results beat says so. ' +
  'Sanity check: if median(off) < 1.5 × the direct median the task is too easy; make it harder once ' +
  '(smaller rock or tighter placement) and re-run; if delay still barely hurts, go to B + C. ' +
  "The 0.75 is a judgment call between Richter's 0.81 at 1 s and Sheridan's implied 0.40-0.67; it does not change after the data.";

/**
 * Parses CSV text (RFC 4180: quoted fields, doubled quotes, CRLF or LF, optional BOM).
 * Returns rows of raw strings; blank lines are skipped.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(field);
    field = '';
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += c;
      }
      i += 1;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') endRow();
    else if (c !== '\r') field += c;
    i += 1;
  }
  if (quoted) throw new Error('CSV ends inside a quoted field');
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/**
 * Checks the header against the 33 columns, in order.
 * @param {string[]} header
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function checkHeader(header) {
  const problems = [];
  const names = header.map((h) => h.trim());
  if (names.length !== COLUMNS.length) problems.push(`header has ${names.length} columns, expected ${COLUMNS.length}`);
  for (const col of COLUMNS) if (!names.includes(col)) problems.push(`missing column ${col}`);
  for (const name of names) if (!COLUMNS.includes(name)) problems.push(`unexpected column ${name}`);
  if (problems.length === 0) {
    names.forEach((name, i) => {
      if (name !== COLUMNS[i]) problems.push(`column ${i + 1} is ${name}, expected ${COLUMNS[i]}`);
    });
  }
  return { ok: problems.length === 0, problems };
}

function flag(raw, name, rowNo) {
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false' || v === '') return false;
  throw new Error(`row ${rowNo}: ${name} is "${raw}", expected 1 or 0`);
}

function num(raw, name, rowNo) {
  const v = raw.trim();
  if (v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`row ${rowNo}: ${name} is "${raw}", expected a number or empty`);
  return n;
}

/**
 * @typedef {object} Trial
 * @property {number} rowNo 1-based data row number in the file
 * @property {number} trialIdx
 * @property {string} block
 * @property {'direct'|'ghost_off'|'ghost_on'} condition
 * @property {boolean} practice
 * @property {boolean} excluded
 * @property {string} excludeReason
 * @property {string} operator
 * @property {string} inputSource
 * @property {number|null} delayOnewayMs
 * @property {boolean} success
 * @property {number|null} completionS
 * @property {number|null} reachS
 * @property {number|null} graspS
 */

/**
 * Reads the CSV text into trials. Throws on a bad header or a malformed value.
 * Returns warnings for rows that break the logger's rules but can still be scored.
 * @param {string} text
 * @returns {{ trials: Trial[], warnings: string[], rowCount: number }}
 */
export function readTrials(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error('CSV is empty');
  const header = rows[0];
  const check = checkHeader(header);
  if (!check.ok) throw new Error(`header check failed: ${check.problems.join('; ')}`);
  const warnings = [];
  const trials = rows.slice(1).map((cells, i) => {
    const rowNo = i + 1;
    if (cells.length !== COLUMNS.length) throw new Error(`row ${rowNo} has ${cells.length} fields, expected ${COLUMNS.length}`);
    /** @type {Record<string, string>} */
    const r = {};
    COLUMNS.forEach((col, j) => {
      r[col] = cells[j] ?? '';
    });
    const condition = r.condition.trim();
    if (!CONDITIONS.includes(condition)) throw new Error(`row ${rowNo}: condition is "${r.condition}", expected direct, ghost_off or ghost_on`);
    const trialIdx = num(r.trial_idx, 'trial_idx', rowNo);
    const trial = {
      rowNo,
      trialIdx: trialIdx ?? rowNo,
      block: r.block.trim(),
      condition: /** @type {Trial['condition']} */ (condition),
      practice: flag(r.practice, 'practice', rowNo),
      excluded: flag(r.excluded, 'excluded', rowNo),
      excludeReason: r.exclude_reason.trim(),
      operator: r.operator.trim(),
      inputSource: r.input_source.trim(),
      delayOnewayMs: num(r.delay_oneway_ms, 'delay_oneway_ms', rowNo),
      success: flag(r.success, 'success', rowNo),
      completionS: num(r.completion_s, 'completion_s', rowNo),
      reachS: num(r.reach_s, 'reach_s', rowNo),
      graspS: num(r.grasp_s, 'grasp_s', rowNo),
    };
    if (trial.success && trial.completionS === null) warnings.push(`row ${rowNo}: success=1 but completion_s is empty; ranked as a failure`);
    if (!trial.success && trial.completionS !== null) warnings.push(`row ${rowNo}: success=0 but completion_s is filled (the logger leaves it empty on failure); ignored`);
    if (trial.excluded && trial.excludeReason === '') warnings.push(`row ${rowNo}: excluded=1 with no exclude_reason`);
    return trial;
  });
  return { trials, warnings, rowCount: rows.length - 1 };
}

/**
 * Median of numbers that may include Infinity. Returns null for an empty list.
 * With an even count the two middle values are averaged, so a failure in the middle gives Infinity.
 * @param {number[]} values
 * @returns {number|null}
 */
export function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return /** @type {number} */ (s[mid]);
  const lo = /** @type {number} */ (s[mid - 1]);
  const hi = /** @type {number} */ (s[mid]);
  return hi === Infinity ? Infinity : (lo + hi) / 2;
}

/**
 * Completion time used for ranking: the logged time for a success, Infinity for a failure.
 * @param {Trial} t
 */
export function rankTime(t) {
  return t.success && t.completionS !== null ? t.completionS : Infinity;
}

function binom(n, k) {
  let c = 1;
  for (let i = 1; i <= k; i += 1) c = (c * (n - k + i)) / i;
  return c;
}

/**
 * Exact two-sided sign test p for `wins` against `losses` (ties already left out).
 * Returns null when there are no untied pairs.
 * @param {number} wins
 * @param {number} losses
 * @returns {number|null}
 */
export function signTestP(wins, losses) {
  const n = wins + losses;
  if (n === 0) return null;
  const k = Math.min(wins, losses);
  let tail = 0;
  for (let i = 0; i <= k; i += 1) tail += binom(n, i);
  return Math.min(1, (2 * tail) / 2 ** n);
}

/**
 * Pairs ghost_on with ghost_off trials within each block, in trial order.
 * @param {Trial[]} counted ghost_on and ghost_off trials (practice and excluded already dropped)
 */
export function pairWins(counted) {
  /** @type {Map<string, Trial[]>} */
  const blocks = new Map();
  for (const t of counted) {
    const list = blocks.get(t.block) ?? [];
    list.push(t);
    blocks.set(t.block, list);
  }
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let unpaired = 0;
  for (const list of blocks.values()) {
    const sorted = [...list].sort((a, b) => a.trialIdx - b.trialIdx);
    const on = sorted.filter((t) => t.condition === 'ghost_on');
    const off = sorted.filter((t) => t.condition === 'ghost_off');
    const n = Math.min(on.length, off.length);
    unpaired += on.length + off.length - 2 * n;
    for (let i = 0; i < n; i += 1) {
      const a = rankTime(/** @type {Trial} */ (on[i]));
      const b = rankTime(/** @type {Trial} */ (off[i]));
      if (a < b) wins += 1;
      else if (a > b) losses += 1;
      else ties += 1;
    }
  }
  return { wins, losses, ties, pairs: wins + losses + ties, unpaired, p: signTestP(wins, losses) };
}

/**
 * The pass rule. Medians may be Infinity ("not reached"); null means no trials.
 * @param {{ medianOn: number|null, medianOff: number|null, successesOn: number, successesOff: number }} s
 * @returns {{ verdict: 'GO'|'AMBIGUOUS'|'NO-GO', ratio: number|null, reason: string }}
 */
export function decide({ medianOn, medianOff, successesOn, successesOff }) {
  if (medianOn === null || medianOff === null) {
    return { verdict: 'NO-GO', ratio: null, reason: 'cannot compare: a condition has no counted trials' };
  }
  let ratio;
  if (medianOn === Infinity && medianOff === Infinity) ratio = null;
  else if (medianOff === Infinity) ratio = 0;
  else if (medianOn === Infinity) ratio = Infinity;
  else ratio = medianOn / medianOff;
  const ratioText = ratio === null ? 'undefined' : ratio === Infinity ? 'not reached with the ghost' : ratio.toFixed(3);
  if (successesOn < successesOff) {
    return { verdict: 'NO-GO', ratio, reason: `fewer successes with the ghost (${successesOn} against ${successesOff}); ratio ${ratioText}` };
  }
  if (ratio === null) {
    return { verdict: 'NO-GO', ratio, reason: 'ratio undefined: half or more of the trials failed in both conditions, so neither median was reached' };
  }
  const succ = `successes ${successesOn} with the ghost against ${successesOff} without (not lower)`;
  if (ratio <= RULE.goRatio + EPS) return { verdict: 'GO', ratio, reason: `ratio ${ratioText} ≤ ${RULE.goRatio} and ${succ}` };
  if (ratio <= RULE.ambiguousRatio + EPS) {
    return { verdict: 'AMBIGUOUS', ratio, reason: `ratio ${ratioText} is in ${RULE.goRatio}-${RULE.ambiguousRatio.toFixed(2)} and ${succ}` };
  }
  return { verdict: 'NO-GO', ratio, reason: `ratio ${ratioText} > ${RULE.ambiguousRatio.toFixed(2)}` };
}

/**
 * The sanity check: the delay has to hurt.
 * @param {{ medianOff: number|null, medianDirect: number|null }} s
 * @returns {{ status: 'ok'|'too-easy'|'not-checked', factor: number|null, reason: string }}
 */
export function sanity({ medianOff, medianDirect }) {
  if (medianDirect === null || medianOff === null) {
    return { status: 'not-checked', factor: null, reason: 'no direct baseline or no ghost_off trials' };
  }
  if (medianDirect === Infinity) {
    return { status: 'not-checked', factor: null, reason: 'the direct baseline median was not reached (half or more failed)' };
  }
  const factor = medianOff === Infinity ? Infinity : medianOff / medianDirect;
  if (factor + EPS < RULE.sanityFactor) {
    return {
      status: 'too-easy',
      factor,
      reason: `median(off) is ${factor.toFixed(2)} × the direct median, under ${RULE.sanityFactor}: the task is too easy. The rule says make it harder once (smaller rock or tighter placement) and re-run; if delay still barely hurts, go to B + C`,
    };
  }
  const shown = factor === Infinity ? 'not reached (off median)' : `${factor.toFixed(2)} ×`;
  return { status: 'ok', factor, reason: `median(off) is ${shown} the direct median (needs ≥ ${RULE.sanityFactor}): the delay hurts` };
}

/** @param {Trial[]} list */
function conditionStats(list) {
  const successes = list.filter((t) => t.success && t.completionS !== null);
  const vals = (key) => list.map((t) => t[key]).filter((v) => v !== null);
  const reach = vals('reachS');
  const grasp = vals('graspS');
  return {
    n: list.length,
    delaysMs: [...new Set(list.map((t) => t.delayOnewayMs))].sort((a, b) => (a ?? -1) - (b ?? -1)),
    successes: successes.length,
    medianCompletion: median(list.map(rankTime)),
    medianCompletionSuccesses: median(successes.map((t) => /** @type {number} */ (t.completionS))),
    medianReach: median(/** @type {number[]} */ (reach)),
    reachN: reach.length,
    medianGrasp: median(/** @type {number[]} */ (grasp)),
    graspN: grasp.length,
  };
}

/**
 * Everything the two scripts print, from the trials.
 * @param {Trial[]} trials
 */
export function summarize(trials) {
  const practiceDropped = trials.filter((t) => t.condition !== 'direct' && t.practice && !t.excluded).length;
  const excludedDropped = trials.filter((t) => t.excluded).length;
  const counted = trials.filter((t) => t.condition !== 'direct' && !t.practice && !t.excluded);
  const directRows = trials.filter((t) => t.condition === 'direct' && !t.excluded);
  const off = conditionStats(counted.filter((t) => t.condition === 'ghost_off'));
  const on = conditionStats(counted.filter((t) => t.condition === 'ghost_on'));
  const direct = conditionStats(directRows);
  const rule = decide({
    medianOn: on.n ? on.medianCompletion : null,
    medianOff: off.n ? off.medianCompletion : null,
    successesOn: on.successes,
    successesOff: off.successes,
  });
  const check = sanity({ medianOff: off.n ? off.medianCompletion : null, medianDirect: direct.n ? direct.medianCompletion : null });
  const gateRows = counted.filter((t) => t.operator === 'ahmed' && t.inputSource === 'webcam').length;
  const operators = [...new Set(counted.map((t) => t.operator))];
  const inputs = [...new Set(counted.map((t) => t.inputSource))];
  return {
    total: trials.length,
    practiceDropped,
    excludedDropped,
    excludeReasons: trials.filter((t) => t.excluded).map((t) => t.excludeReason || '(no reason)'),
    countedN: counted.length,
    off,
    on,
    direct,
    pairs: pairWins(counted),
    rule,
    sanity: check,
    gateRows,
    gateData: counted.length > 0 && gateRows === counted.length && gateRows >= RULE.gateMinRows,
    operators,
    inputs,
  };
}

/**
 * Seconds for display: "12.30 s", "not reached" for Infinity, "n/a" for null.
 * @param {number|null} v
 */
export function fmtS(v) {
  if (v === null) return 'n/a';
  if (v === Infinity) return 'not reached';
  return `${v.toFixed(2)} s`;
}

/** @param {number|null} p */
export function fmtP(p) {
  return p === null ? 'n/a (no untied pairs)' : p.toFixed(4);
}

/**
 * A plain caption from the data itself, so it can never claim more than the rows show.
 * @param {ReturnType<typeof summarize>} s
 */
export function caption(s) {
  const who = s.operators.length === 1 ? `one operator (${s.operators[0]})` : `${s.operators.length} operators (${s.operators.join(', ')})`;
  const input = s.inputs.join(', ');
  const base = `${s.countedN} counted trials, ${who}, ${input}, simulation`;
  return s.gateData ? base : `${base}. NOT GATE DATA: the gate counts only operator=ahmed with input_source=webcam, at least ${RULE.gateMinRows} rows (${s.gateRows} here)`;
}
