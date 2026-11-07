// Types for gate.mjs, so the app's TypeScript unit tests (web/src/gate/) can import it.

export declare const COLUMNS: readonly string[];
export declare const CONDITIONS: readonly ['direct', 'ghost_off', 'ghost_on'];
export declare const RULE: Readonly<{ goRatio: number; ambiguousRatio: number; sanityFactor: number; gateMinRows: number }>;
export declare const PASS_RULE_TEXT: string;

export type Verdict = 'GO' | 'AMBIGUOUS' | 'NO-GO';

export interface Trial {
  rowNo: number;
  trialIdx: number;
  block: string;
  condition: 'direct' | 'ghost_off' | 'ghost_on';
  practice: boolean;
  excluded: boolean;
  excludeReason: string;
  operator: string;
  inputSource: string;
  delayOnewayMs: number | null;
  success: boolean;
  completionS: number | null;
  reachS: number | null;
  graspS: number | null;
}

export interface ConditionStats {
  n: number;
  /** Distinct delay_oneway_ms values in this condition (null for empty cells). */
  delaysMs: (number | null)[];
  successes: number;
  medianCompletion: number | null;
  medianCompletionSuccesses: number | null;
  medianReach: number | null;
  reachN: number;
  medianGrasp: number | null;
  graspN: number;
}

export interface PairResult {
  wins: number;
  losses: number;
  ties: number;
  pairs: number;
  unpaired: number;
  p: number | null;
}

export interface Summary {
  total: number;
  practiceDropped: number;
  excludedDropped: number;
  excludeReasons: string[];
  countedN: number;
  off: ConditionStats;
  on: ConditionStats;
  direct: ConditionStats;
  pairs: PairResult;
  rule: { verdict: Verdict; ratio: number | null; reason: string };
  sanity: { status: 'ok' | 'too-easy' | 'not-checked'; factor: number | null; reason: string };
  gateRows: number;
  gateData: boolean;
  operators: string[];
  inputs: string[];
}

export declare function parseCsv(text: string): string[][];
export declare function checkHeader(header: string[]): { ok: boolean; problems: string[] };
export declare function readTrials(text: string): { trials: Trial[]; warnings: string[]; rowCount: number };
export declare function median(values: number[]): number | null;
export declare function rankTime(t: Trial): number;
export declare function signTestP(wins: number, losses: number): number | null;
export declare function pairWins(counted: Trial[]): PairResult;
export declare function decide(s: {
  medianOn: number | null;
  medianOff: number | null;
  successesOn: number;
  successesOff: number;
}): { verdict: Verdict; ratio: number | null; reason: string };
export declare function sanity(s: {
  medianOff: number | null;
  medianDirect: number | null;
}): { status: 'ok' | 'too-easy' | 'not-checked'; factor: number | null; reason: string };
export declare function summarize(trials: Trial[]): Summary;
export declare function fmtS(v: number | null): string;
export declare function fmtP(p: number | null): string;
export declare function caption(s: Summary): string;
