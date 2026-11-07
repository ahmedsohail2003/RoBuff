#!/usr/bin/env node
// Scores a ghost gate CSV from the trial logger by the pass rule fixed before the data
// (PLAN.md §4 M4c; definitions in scripts/lib/gate.mjs). Prints the medians, successes with
// denominators, the reach/grasp split, pair wins with the exact sign-test p, the sanity check,
// then VERDICT: GO|AMBIGUOUS|NO-GO and a one-line reason. Reads the CSV only; writes nothing.
// Exit 0 when scored, 2 when the file cannot be scored (bad header, malformed row, no trials).
// Usage: node scripts/trials-verdict.mjs <csv>
import { readFileSync } from 'node:fs';
import { COLUMNS, RULE, caption, fmtP, fmtS, readTrials, summarize } from './lib/gate.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/trials-verdict.mjs <csv>');
  process.exit(2);
}

let parsed;
try {
  parsed = readTrials(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`cannot score ${file}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

const s = summarize(parsed.trials);
if (s.on.n === 0 || s.off.n === 0) {
  console.error(`cannot score ${file}: ${s.on.n} counted ghost_on and ${s.off.n} counted ghost_off trials (both must be above 0)`);
  process.exit(2);
}

const line = (name, c) =>
  `${name.padEnd(9)} median completion ${fmtS(c.medianCompletion)} (failures ranked slowest; successes only ${fmtS(c.medianCompletionSuccesses)}), ` +
  `successes ${c.successes}/${c.n}, median reach ${fmtS(c.medianReach)} (n=${c.reachN}), median grasp ${fmtS(c.medianGrasp)} (n=${c.graspN})`;

const out = [
  `Ghost gate verdict for ${file}`,
  `Header: ${COLUMNS.length} columns in the logged order: OK`,
  `Rows: ${s.total} read; ${s.practiceDropped} ghost-condition practice and ${s.excludedDropped} excluded dropped` +
    (s.excludedDropped ? ` (${s.excludeReasons.join('; ')})` : '') +
    `; ${s.countedN} counted (ghost_off ${s.off.n}, ghost_on ${s.on.n}); direct baseline ${s.direct.n} rows`,
  ...parsed.warnings.map((w) => `Warning: ${w}`),
  s.gateData
    ? `Gate data: ${s.gateRows} counted rows, all operator=ahmed with input_source=webcam (needs ≥ ${RULE.gateMinRows})`
    : `NOT GATE DATA: ${s.gateRows} of ${s.countedN} counted rows are operator=ahmed with input_source=webcam, and the gate needs all of them and ≥ ${RULE.gateMinRows} (seen: operator ${s.operators.join(', ')}; input_source ${s.inputs.join(', ')}). Mouse and synthetic runs are never counted.`,
  line('ghost_off', s.off),
  line('ghost_on', s.on),
  line('direct', s.direct),
  `Ratio median(on) / median(off): ${s.rule.ratio === null ? 'undefined' : s.rule.ratio === Infinity ? 'not reached' : s.rule.ratio.toFixed(3)}`,
  `Pair wins (ghost_on faster than ghost_off within each block): ${s.pairs.wins} of ${s.pairs.wins + s.pairs.losses}` +
    ` (${s.pairs.ties} ties left out, ${s.pairs.unpaired} unpaired), exact two-sided sign-test p = ${fmtP(s.pairs.p)} (reported, not used to decide)`,
  `Sanity: ${s.sanity.status.toUpperCase()}: ${s.sanity.reason}`,
  `Caption: ${caption(s)}`,
  `VERDICT: ${s.rule.verdict}`,
  `Reason: ${s.rule.reason}${s.sanity.status === 'too-easy' ? '. The sanity check failed, so this verdict does not decide the pitch until the harder re-run' : ''}`,
];
console.log(out.join('\n'));
