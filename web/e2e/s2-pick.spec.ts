import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { PickReport } from '../src/control/pickCheck';
import { finishRun, startRun, watchProblems } from './pickRun';

/** web/evidence (git-ignored) unless EVIDENCE_DIR is set; playwright.config.ts sets the same default. */
const EVIDENCE_DIR = path.resolve(process.env.EVIDENCE_DIR ?? path.join(import.meta.dirname, '../evidence'));
/** Simulated seconds per wall second. Control runs on simulated time, so this only saves waiting. */
const SPEED = 3;
const REPEATS = 5;

async function openSynthetic(page: Page, problems: string[]): Promise<void> {
  watchProblems(page, problems);
  await page.goto(`/?input=synthetic&speed=${SPEED}`);
  await page.waitForFunction(() => window.__sim?.ready === true, undefined, { timeout: 60_000 });
  expect(await page.evaluate(() => window.__sim!.input().kind)).toBe('synthetic');
}

test('scripted synthetic hand picks up the 3 cm cube by friction', async ({ page }) => {
  const problems: string[] = [];
  await openSynthetic(page, problems);
  await startRun(page);

  // Screenshot while the cube is held up in the air.
  await page.waitForFunction(() => window.__sim!.input().phase === 'hold', undefined, { timeout: 60_000 });
  await page.waitForTimeout(300);
  const held = await page.evaluate(() => ({ cube: window.__sim!.getBodyPos('cube'), gap: window.__sim!.gripperOpening() }));
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's2.png') });
  console.log(`S2_SCREENSHOT_STATE ${JSON.stringify(held)}`);

  const report = await finishRun(page);
  console.log(`S2_PICK ${JSON.stringify(report)}`);
  writeFileSync(path.join(EVIDENCE_DIR, 's2-pick.json'), JSON.stringify(report, null, 2));
  expect(report.failures).toEqual([]);
  for (const error of Object.values(report.waypointErrors)) expect(error).toBeLessThan(0.015);
  expect(report.maxRise).toBeGreaterThanOrEqual(0.05);
  expect(report.heldS).toBeGreaterThanOrEqual(2);
  expect(report.heldPenetration).toBeLessThanOrEqual(0.001);
  expect(report.fallS).not.toBeNull();
  expect(problems).toEqual([]);
});

test(`the pick repeats ${REPEATS} times from reset`, async ({ page }) => {
  test.setTimeout(300_000);
  const problems: string[] = [];
  const loadStart = Date.now();
  await openSynthetic(page, problems);
  const loadMs = Date.now() - loadStart;
  const runs: (PickReport & { samples: number; wallMs: number })[] = [];
  for (let i = 0; i < REPEATS; i++) {
    const runStart = Date.now();
    await startRun(page);
    runs.push({ ...(await finishRun(page)), wallMs: Date.now() - runStart });
  }
  const successes = runs.filter((run) => run.pass).length;
  const summary = {
    successes,
    attempts: REPEATS,
    loadMs,
    runs: runs.map((run) => ({
      pass: run.pass,
      failures: run.failures,
      maxRiseMm: +(run.maxRise * 1000).toFixed(2),
      heldS: +run.heldS.toFixed(2),
      heldPenetrationMm: +(run.heldPenetration * 1000).toFixed(3),
      fallS: run.fallS,
      worstWaypointMm: +(Math.max(...Object.values(run.waypointErrors)) * 1000).toFixed(2),
      samples: run.samples,
      wallMs: run.wallMs,
    })),
  };
  console.log(`S2_REPEAT ${JSON.stringify(summary)}`);
  writeFileSync(path.join(EVIDENCE_DIR, 's2-repeat.json'), JSON.stringify(summary, null, 2));
  expect(successes).toBe(REPEATS);
  expect(problems).toEqual([]);
});
