import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { finishRun, startRun, watchProblems } from './pickRun';

/** web/evidence (git-ignored) unless EVIDENCE_DIR is set; playwright.config.ts sets the same default. */
const EVIDENCE_DIR = path.resolve(process.env.EVIDENCE_DIR ?? path.join(import.meta.dirname, '../evidence'));
type V3 = [number, number, number];

interface Sample {
  t: number;
  truth: V3;
  seen: V3;
  ghost: V3 | null;
  rockZ: number;
  errorMm: number | null;
  level: string | null;
  physicsMs: number;
  fps: number;
}

/** Linear interpolation of z at time t over samples sorted by time. */
function zAt(samples: { t: number; z: number }[], t: number): number | null {
  if (t < samples[0]!.t || t > samples[samples.length - 1]!.t) return null;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo]!;
  const b = samples[hi]!;
  return b.t === a.t ? a.z : a.z + ((b.z - a.z) * (t - a.t)) / (b.t - a.t);
}

/** The shift L (s) that best lines up follower(t + L) with leader(t), by mean absolute z difference. */
function lagOf(leader: { t: number; z: number }[], follower: { t: number; z: number }[]): { lag: number; meanAbsMm: number } {
  let best = { lag: 0, meanAbsMm: Infinity };
  for (let k = 0; k <= 300; k++) {
    const lag = k * 0.01;
    let sum = 0;
    let n = 0;
    for (const s of leader) {
      const z = zAt(follower, s.t + lag);
      if (z === null) continue;
      sum += Math.abs(z - s.z);
      n++;
    }
    if (n > 50 && sum / n < best.meanAbsMm / 1000) best = { lag, meanAbsMm: (sum / n) * 1000 };
  }
  return best;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

test('Earth-Moon delay: direct pick, Moon with the ghost, lag of each line, error meter, two-simulation cost, one logged trial', async ({ page }) => {
  test.setTimeout(300_000);
  const problems: string[] = [];
  watchProblems(page, problems);
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.goto('/?input=synthetic&trial=1&persist=0');
  await page.waitForFunction(() => window.__sim?.ready === true && typeof window.__sim.setDelayMode === 'function', undefined, { timeout: 90_000 });
  await expect(page.getByTestId('delay-panel')).toBeVisible();
  await expect(page.locator('[data-delay-mode="direct"]')).toHaveAttribute('aria-pressed', 'true');

  // (a) Direct: the plain synthetic pick, unchanged from M1.
  await page.evaluate(() => (window.__sim!.speed = 2));
  await startRun(page);
  const direct = await finishRun(page);
  console.log(`M4_DIRECT pass=${direct.pass} maxRise=${(direct.maxRise * 1000).toFixed(1)}mm held=${direct.heldS.toFixed(2)}s failures=${JSON.stringify(direct.failures)}`);
  expect(direct.maxRise).toBeGreaterThanOrEqual(0.048);

  // (b) Moon, ghost on, from the panel button; the scene resets.
  await page.evaluate(() => (window.__sim!.speed = 1));
  // Moon gravity from the menu first, so entering the mode changes no gravity: only the ghost's
  // registration can update the readout's count.
  await page.click('[data-gravity="moon"]');
  await expect(page.getByTestId('gravity-readout')).toContainText('written to 1 simulation (live 1.62)');
  await page.click('[data-delay-mode="moon_ghost_on"]');
  await expect(page.locator('[data-delay-mode="moon_ghost_on"]')).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
  await expect(page.getByTestId('ghost-mismatch')).toContainText("does not know the rock's true mass");
  await expect(page.getByTestId('delay-text')).toContainText('2.56 s round trip');
  const startState = await page.evaluate(() => window.__sim!.delayState!());
  console.log(`M4_ROCKS truth=${JSON.stringify(startState.truthRockModel)} ghost=${JSON.stringify(startState.ghostRockModel)}`);
  expect(startState.truthRockModel).toMatchObject({ friction: 0.6, priority: 1 });
  expect(startState.ghostRockModel).toMatchObject({ friction: 0.8, priority: 1 });
  expect(startState.ghostMeshes).toBeGreaterThan(5);
  // Entering a Moon mode sets Moon gravity on both simulations (the menu can still change it).
  const grav = await page.evaluate(() => window.__sim!.gravity!());
  console.log(`M4_GRAVITY ${JSON.stringify(grav.sims)}`);
  expect(grav.preset.id).toBe('moon');
  expect(grav.sims).toEqual(expect.arrayContaining([{ name: 'live', gravity_m_s2: 1.62 }, { name: 'ghost', gravity_m_s2: 1.62 }]));
  // The menu's readout counts the ghost too, as soon as it registers.
  const readout = page.getByTestId('gravity-readout');
  await expect(readout).toContainText('written to 2 simulations');
  await expect(readout).toContainText('ghost 1.62');
  console.log(`M4_GRAVITY_READOUT ${await readout.textContent()}`);

  await page.evaluate(() => {
    const w = window as unknown as { __m4: { samples: unknown[]; done: boolean } };
    w.__m4 = { samples: [], done: false };
    const sim = window.__sim!;
    const rest = sim.delayState!().truthRock![2];
    const loop = () => {
      const s = sim.delayState!();
      w.__m4.samples.push({ t: s.simTime, truth: s.truthGripper, seen: s.seenGripper, ghost: s.ghostGripper, rockZ: s.truthRock![2] - rest, errorMm: s.error ? Math.max(s.error.gripper_mm, s.error.rock_mm ?? 0) : null, level: s.error?.level ?? null, physicsMs: sim.lastPhysicsMs, fps: sim.fps });
      if (s.simTime < 14.5) requestAnimationFrame(loop);
      else w.__m4.done = true;
    };
    requestAnimationFrame(loop);
  });
  // Two arms apart on screen: the ghost has moved, the truth has not been seen to yet.
  await page.waitForFunction(() => window.__sim!.simTime > 3.4, undefined, { timeout: 60_000 });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's6.png') });
  const midState = await page.evaluate(() => window.__sim!.delayState!());
  expect(midState.ghostVisible).toBe(true);
  await page.waitForFunction(() => (window as unknown as { __m4: { done: boolean } }).__m4.done, undefined, { timeout: 120_000 });
  const samples = await page.evaluate(() => (window as unknown as { __m4: { samples: Sample[] } }).__m4.samples);
  const moonRise = Math.max(...samples.map((s) => s.rockZ));
  const ghostZ = samples.filter((s) => s.ghost).map((s) => ({ t: s.t, z: s.ghost![2] }));
  const truthZ = samples.map((s) => ({ t: s.t, z: s.truth[2] }));
  const seenZ = samples.map((s) => ({ t: s.t, z: s.seen[2] }));
  const ghostToTruth = lagOf(ghostZ, truthZ);
  const truthToSeen = lagOf(truthZ, seenZ);
  const ghostToSeen = lagOf(ghostZ, seenZ);
  const warm = samples.filter((s) => s.t > 1);
  const physicsMedian = median(warm.map((s) => s.physicsMs));
  const fpsMedian = median(warm.filter((s) => s.fps > 0).map((s) => s.fps));
  const errors = samples.filter((s) => s.errorMm !== null).map((s) => s.errorMm!);
  const levels = [...new Set(samples.map((s) => s.level).filter(Boolean))];
  const report = {
    direct: { pass: direct.pass, maxRise_mm: direct.maxRise * 1000, held_s: direct.heldS, failures: direct.failures },
    moon: {
      samples: samples.length,
      truthRockRise_mm: moonRise * 1000,
      lag_ghost_to_truth_s: ghostToTruth,
      lag_truth_to_seen_s: truthToSeen,
      lag_ghost_to_seen_s: ghostToSeen,
      lastPhysicsMs_median_two_sims: physicsMedian,
      lastPhysicsMs_max: Math.max(...warm.map((s) => s.physicsMs)),
      fps_median: fpsMedian,
      meter_max_mm: errors.length ? Math.max(...errors) : null,
      meter_samples: errors.length,
      meter_levels_seen: levels,
      rocks: { truth: startState.truthRockModel, ghost: startState.ghostRockModel },
    },
  };
  console.log(`M4_MOON ${JSON.stringify(report.moon)}`);
  expect(moonRise).toBeGreaterThanOrEqual(0.048);
  expect(Math.abs(ghostToTruth.lag - 1.28)).toBeLessThanOrEqual(0.05);
  expect(Math.abs(truthToSeen.lag - 1.28)).toBeLessThanOrEqual(0.05);
  expect(physicsMedian).toBeLessThan(4);
  expect(fpsMedian).toBeGreaterThanOrEqual(45);
  expect(errors.length).toBeGreaterThan(0);

  // (c) Logged trials through the runner: trial 1 is a direct warm-up; the order then has three
  // more warm-ups, a ghost-off practice trial, and trial 6, the first Moon-ghost-on trial.
  await expect(page.getByTestId('trial-title')).toContainText('Trial 1/20: DIRECT');
  await page.evaluate(() => (window.__sim!.speed = 2));
  const row = await page.evaluate(() => window.__sim!.runTrial!(0));
  expect(row.success).toBe('1');
  expect(row.operator).toBe('synthetic-hand');
  expect(row.input_source).toBe('synthetic');
  await expect(page.getByTestId('trial-title')).toContainText('Trial 2/20: DIRECT');
  const rows = [row];
  while (rows[rows.length - 1]!.condition !== 'ghost_on' && rows.length < 6) rows.push(await page.evaluate(() => window.__sim!.runTrial!(0)));
  const ghostRow = rows[rows.length - 1]!;
  const csv = await page.evaluate(() => window.__sim!.trialCsv!());
  const lines = csv.trim().split('\n');
  console.log(`M4_TRIAL_CSV\n${csv}`);
  console.log(`M4_TRIAL_ROWS ${rows.map((r) => `${r.trial_idx}:${r.condition}:success=${r.success}:completion=${r.completion_s}`).join(' ')}`);
  expect(rows.map((r) => r.condition)).toEqual(['direct', 'direct', 'direct', 'direct', 'ghost_off', 'ghost_on']);
  expect(ghostRow.success).toBe('1');
  expect(ghostRow.operator).toBe('synthetic-hand');
  expect(ghostRow.input_source).toBe('synthetic');
  // The CSV itself, by column name: the last row is the Moon-ghost-on trial, a success.
  const header = lines[0]!.split(',');
  const last = Object.fromEntries(lines[lines.length - 1]!.split(',').map((v, i) => [header[i]!, v]));
  expect(last).toMatchObject({ condition: 'ghost_on', success: '1' });
  expect(lines).toHaveLength(7);
  for (const line of lines) expect(line.split(',')).toHaveLength(33);
  await expect(readout).toContainText('written to 2 simulations');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('trial-download').click()]);
  const name = download.suggestedFilename();
  const expectedName = await page.evaluate(() => window.__sim!.trialCsvName!());
  console.log(`M4_DOWNLOAD ${name}`);
  expect(name).toBe(expectedName);
  expect(name).toMatch(/^ghost-gate-s\d{8}-\d{6}\.csv$/);

  writeFileSync(path.join(EVIDENCE_DIR, 's6-delay-ghost.json'), JSON.stringify({ ...report, trial: { row, ghostRow, rows, csv, download: name } }, null, 2));
  expect(problems).toEqual([]);
});
