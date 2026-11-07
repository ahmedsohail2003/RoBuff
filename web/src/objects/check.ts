// The whole check for one request: cheap pipeline, then settle, then the simulated lift test if one is supplied.

import type { MainModule } from '@mujoco/mujoco';
import { validate, type ValidateOptions } from './guardrail';
import { proveLift, type LiftTester } from './lift';
import type { Receipt } from './receipt';
import { settle, withSettle, type SettleReport } from './settle';

export interface CheckOptions extends ValidateOptions {
  liftTester?: LiftTester;
}

export interface CheckResult {
  receipt: Receipt;
  settle: SettleReport | null;
}

/** Without a lift tester the best a receipt can read is READY_FOR_LIFT_TEST, never PASS. */
export async function checkObject(mj: MainModule, rawSpec: unknown, options: CheckOptions = {}): Promise<CheckResult> {
  let receipt = validate(rawSpec, options);
  if (receipt.verdict === 'REFUSED') return { receipt, settle: null };
  const report = settle(mj, receipt, { gravity_m_s2: receipt.gravity_m_s2 });
  receipt = withSettle(receipt, report);
  if (options.liftTester) receipt = await proveLift(receipt, options.liftTester);
  return { receipt, settle: report };
}
