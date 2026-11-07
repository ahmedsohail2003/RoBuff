import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { evaluatePick, type PickSample } from '../src/control/pickCheck';
import type { ContactReport, Vec3 } from '../src/sim/simulation';
import { watchProblems } from './pickRun';

const EVIDENCE_DIR = path.resolve(process.env.EVIDENCE_DIR ?? path.join(import.meta.dirname, '../evidence'));
const SPEED = 3;
const JAWS = ['Fixed_Jaw', 'Moving_Jaw'];

interface Stage {
  code: string;
  state: string;
  text: string;
}
interface Outcome {
  spawned: boolean;
  stages: Stage[];
  receipt: {
    verdict: string;
    mass_kg: number | null;
    rest: { lowest_mm: number; height_mm: number; position_m: Vec3 } | null;
    lift: { status: string; attempts: { rise_mm: number; hold_s?: number; wall_ms?: number; yaw_deg: number }[] };
  };
  runs: { rise_mm: number; hold_s: number; wall_ms: number; longest_block_ms: number; physics_steps: number }[];
  timings: { recompile_ms: number | null; swap_ms: number | null; settle_ms: number | null; lift_ms: number | null; total_ms: number };
}

async function open(page: Page, problems: string[]): Promise<void> {
  watchProblems(page, problems);
  await page.goto(`/?speed=${SPEED}`);
  await page.waitForFunction(() => window.__sim?.ready === true && typeof window.__sim.spawnObject === 'function', undefined, { timeout: 90_000 });
  await expect(page.getByTestId('offline-mock')).toBeVisible();
}

/** Records gaps between animation frames while a request runs, so a frozen page would show. */
async function watchFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __gaps: number[]; __gapStop: boolean };
    w.__gaps = [];
    w.__gapStop = false;
    let last = performance.now();
    const tick = (now: number) => {
      w.__gaps.push(now - last);
      last = now;
      if (!w.__gapStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function longestFrameGap(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as { __gaps: number[]; __gapStop: boolean };
    w.__gapStop = true;
    return Math.max(...w.__gaps);
  });
}

const outcome = (page: Page): Promise<Outcome> => page.evaluate(() => window.__sim!.lastOutcome as unknown as Outcome);
const spawn = (page: Page, text: string): Promise<Outcome> => page.evaluate((t) => window.__sim!.spawnObject!(t) as unknown as Promise<Outcome>, text);
const stage = (o: Outcome, code: string): Stage | undefined => o.stages.find((s) => s.code === code);

test('(a, e) Bennu-like sample from the panel: every stage ticks, the headless lift test passes, and the live arm picks it', async ({ page }) => {
  const problems: string[] = [];
  await open(page, problems);
  await watchFrames(page);
  await page.click('[data-preset="bennu"]');
  await expect(page.getByTestId('object-verdict')).toHaveAttribute('data-verdict', 'PASS', { timeout: 60_000 });
  const gapMs = await longestFrameGap(page);
  const result = await outcome(page);
  console.log(`S5_BENNU ${JSON.stringify({ gapMs, timings: result.timings, runs: result.runs, stages: result.stages.map((s) => `${s.code}:${s.state}`), rest: result.receipt.rest })}`);

  // Every stage shown, none left running.
  const items = await page
    .locator('[data-testid="receipt-list"] li')
    .evaluateAll((nodes) => nodes.map((n) => ({ code: n.getAttribute('data-code'), state: n.getAttribute('data-state') })));
  for (const code of ['REQUEST', 'SANITY_OK', 'HULL_OK', 'YAW_CHOSEN', 'SCALE_OK', 'MASS_OK', 'FRICTION_OK', 'GRIP_OK', 'RECOMPILE', 'LIFT_OK']) {
    expect(items.map((i) => i.code), code).toContain(code);
  }
  expect(items.some((i) => i.code === 'SETTLED' || i.code === 'ROLLS')).toBe(true);
  expect(items.every((i) => i.state !== 'running' && i.state !== 'pending')).toBe(true);
  expect(stage(result, 'HULL_OK')!.text).toContain('measured after loading');

  // A real measured rise from the headless lift test.
  expect(result.receipt.verdict).toBe('PASS');
  expect(result.receipt.lift.attempts.at(-1)!.rise_mm).toBeGreaterThanOrEqual(48);
  expect(result.runs.at(-1)!.physics_steps).toBeGreaterThan(1000);

  // In the live model, at rest near the floor on the pad, and drawn.
  const name = await page.evaluate(() => window.__sim!.objectBodyName!);
  expect(name).not.toBe('cube');
  expect(await page.evaluate(() => window.__sim!.getBodyPos('cube'))).toBeNull();
  const pos = (await page.evaluate((n) => window.__sim!.getBodyPos(n), name))!;
  expect(Math.hypot(pos[0], pos[1] + 0.22)).toBeLessThan(0.04);
  expect(result.receipt.rest!.lowest_mm).toBeGreaterThan(-2);
  expect(result.receipt.rest!.lowest_mm).toBeLessThan(2);
  const drawn = await page.evaluate(() => window.__sim!.objectRender!());
  expect(drawn).not.toBeNull();
  expect(drawn!.vertices).toBeGreaterThan(100);
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's5-bennu.png') });

  // (e) S2's scripted pick in the live sim, aimed at the settled object.
  const plan = await page.evaluate(() => window.__sim!.pickObject!());
  const run = page.evaluate((body) => {
    const sim = window.__sim!;
    const restZ = sim.getBodyPos(body)![2];
    const samples: unknown[] = [];
    return new Promise<{ restZ: number; samples: unknown[] }>((resolve) => {
      const sample = () => {
        const input = sim.input() as Record<string, unknown>;
        if (input.phase) {
          samples.push({
            t: sim.simTime,
            phase: input.phase,
            phaseIndex: input.phaseIndex,
            settled: input.settled,
            waypoint: input.waypoint,
            site: sim.getSitePos('gripper'),
            cube: sim.getBodyPos(body),
            grip: sim.controller().grip ?? 0,
            contacts: sim.contacts(body),
          });
        }
        if (input.done) resolve({ restZ, samples });
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  }, name);
  await page.waitForFunction(() => window.__sim!.input().phase === 'hold', undefined, { timeout: 60_000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's5-held.png') });
  const { restZ, samples } = (await run) as { restZ: number; samples: (Omit<PickSample, 'jawsTouching' | 'jawMinDist'> & { contacts: ContactReport[] })[] };
  const report = evaluatePick(
    samples.map(({ contacts, ...rest }) => {
      const jaw = contacts.filter((c) => JAWS.includes(c.body1) || JAWS.includes(c.body2));
      return {
        ...rest,
        jawsTouching: [...new Set(jaw.map((c) => (JAWS.includes(c.body1) ? c.body1 : c.body2)))].sort(),
        jawMinDist: Math.min(0, ...jaw.map((c) => c.dist)),
      };
    }),
    restZ,
  );
  console.log(`S5_LIVE_PICK ${JSON.stringify({ plan, ...report, samples: samples.length })}`);
  writeFileSync(path.join(EVIDENCE_DIR, 's5-live-pick.json'), JSON.stringify({ plan, report }, null, 2));
  expect(report.maxRise).toBeGreaterThanOrEqual(0.05);
  expect(report.heldS).toBeGreaterThanOrEqual(2);
  expect(gapMs).toBeLessThan(1000);
  expect(problems).toEqual([]);
});

test('(b) an asteroid the size of Texas: TOO_WIDE quotes the size and limit, rescales, then passes the lift test', async ({ page }) => {
  const problems: string[] = [];
  await open(page, problems);
  await page.click('[data-preset="texas"]');
  await expect(page.getByTestId('object-verdict')).toHaveAttribute('data-verdict', 'ADJUSTED', { timeout: 60_000 });
  const result = await outcome(page);
  const wide = stage(result, 'TOO_WIDE')!;
  console.log(`S5_TEXAS ${JSON.stringify({ wide: wide.text, timings: result.timings, runs: result.runs, mass_g: result.receipt.mass_kg! * 1000 })}`);
  expect(wide.state).toBe('adjusted');
  expect(wide.text).toMatch(/kilometre/);
  expect(wide.text).toMatch(/1,200,000,000 millimetres/);
  expect(wide.text).toMatch(/\b55\b/);
  expect(stage(result, 'LIFT_OK')).toBeDefined();
  expect(result.receipt.lift.attempts.at(-1)!.rise_mm).toBeGreaterThanOrEqual(48);
  expect(problems).toEqual([]);
});

test('(c, d) solid iron 60 mm is TOO_HEAVY and not spawned; the comet ice shard is refused at Earth gravity', async ({ page }) => {
  const problems: string[] = [];
  await open(page, problems);
  await page.click('[data-preset="iron"]');
  await expect(page.getByTestId('object-verdict')).toHaveAttribute('data-verdict', 'REFUSED', { timeout: 60_000 });
  const iron = await outcome(page);
  const heavy = stage(iron, 'TOO_HEAVY')!;
  console.log(`S5_IRON ${JSON.stringify({ heavy: heavy.text, notSpawned: stage(iron, 'NOT_SPAWNED')?.text, spawned: iron.spawned })}`);
  expect(heavy.state).toBe('refused');
  expect(heavy.text).toMatch(/\d[\d,]* grams/);
  expect(iron.spawned).toBe(false);
  expect(stage(iron, 'NOT_SPAWNED')).toBeDefined();
  expect(stage(iron, 'RECOMPILE')).toBeUndefined();
  expect(await page.evaluate(() => window.__sim!.objectBodyName)).toBe('cube');
  expect(await page.evaluate(() => window.__sim!.getBodyPos('cube'))).not.toBeNull();

  await page.click('[data-preset="ice"]');
  await expect(page.getByTestId('object-verdict')).toHaveAttribute('data-verdict', 'REFUSED', { timeout: 60_000 });
  const ice = await outcome(page);
  // SLIPS, on Earth gravity, from the friction check: the pads meet the shard off square, and
  // ice's 0.03 cannot stop the squeeze pushing it out. Refused before any spawn or lift test.
  const slips = stage(ice, 'SLIPS');
  console.log(`S5_ICE ${JSON.stringify({ slips: slips?.text ?? null, friction: stage(ice, 'FRICTION_OK')?.text ?? null, notSpawned: stage(ice, 'NOT_SPAWNED')?.text ?? null, runs: ice.runs, spawned: ice.spawned })}`);
  expect(ice.receipt.verdict).toBe('REFUSED');
  expect(slips).toBeDefined();
  expect(slips!.state).toBe('refused');
  expect(slips!.text).toMatch(/\(Earth\)/);
  expect(slips!.text).toMatch(/friction of at least 0\.\d+/);
  expect(slips!.text).toMatch(/Ice is 0\.03\./);
  expect(stage(ice, 'FRICTION_OK')).toBeUndefined();
  expect(stage(ice, 'RECOMPILE')).toBeUndefined();
  expect(stage(ice, 'NOT_SPAWNED')).toBeDefined();
  expect(ice.spawned).toBe(false);
  expect(await page.evaluate(() => window.__sim!.objectBodyName)).toBe('cube');
  expect(problems).toEqual([]);
});

test('browser recompile and lift test times for 5 presets', async ({ page }) => {
  const problems: string[] = [];
  await open(page, problems);
  const rows: Record<string, unknown>[] = [];
  for (const text of ['bennu-sample', 's-type-chip', 'cubesat-panel', 'comms-dish', 'an asteroid the size of Texas']) {
    await watchFrames(page);
    const result = await spawn(page, text);
    const gapMs = await longestFrameGap(page);
    rows.push({
      text,
      verdict: result.receipt.verdict,
      recompile_ms: result.timings.recompile_ms === null ? null : +result.timings.recompile_ms.toFixed(1),
      settle_ms: result.timings.settle_ms === null ? null : +result.timings.settle_ms.toFixed(1),
      lift_ms: result.timings.lift_ms === null ? null : +result.timings.lift_ms.toFixed(0),
      attempts: result.runs.length,
      rise_mm: result.runs.map((r) => +r.rise_mm.toFixed(1)),
      hold_s: result.runs.map((r) => +r.hold_s.toFixed(2)),
      longest_block_ms: result.runs.length ? Math.max(...result.runs.map((r) => +r.longest_block_ms.toFixed(1))) : null,
      longest_frame_gap_ms: +gapMs.toFixed(1),
    });
  }
  console.log(`S5_TIMINGS ${JSON.stringify(rows)}`);
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(EVIDENCE_DIR, 's5-timings.json'), JSON.stringify(rows, null, 2));
  for (const row of rows) expect(row.longest_frame_gap_ms as number).toBeLessThan(1000);
  expect(problems).toEqual([]);
});
