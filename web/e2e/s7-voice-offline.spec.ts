// M5 offline voice: no key server runs here, so the page must go offline by itself.
// A typed request makes an object with a receipt, a caption and the "offline mock" badge;
// "stop" freezes the arm with no network call; the page keeps 50 fps during the request.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { watchProblems } from './pickRun';

const EVIDENCE_DIR = path.resolve(process.env.EVIDENCE_DIR ?? path.join(import.meta.dirname, '../evidence'));

interface Sent {
  url: string;
  at: number;
}

async function frameCounter(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number; __framesStop: boolean; __framesStart: number; __maxGap: number };
    w.__frames = 0;
    w.__framesStop = false;
    w.__framesStart = performance.now();
    w.__maxGap = 0;
    let last = performance.now();
    const tick = (now: number) => {
      w.__frames++;
      w.__maxGap = Math.max(w.__maxGap, now - last);
      last = now;
      if (!w.__framesStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopCounter(page: Page): Promise<{ frames: number; seconds: number; fps: number; longest_frame_ms: number }> {
  return page.evaluate(() => {
    const w = window as unknown as { __frames: number; __framesStop: boolean; __framesStart: number; __maxGap: number };
    w.__framesStop = true;
    const seconds = (performance.now() - w.__framesStart) / 1000;
    return { frames: w.__frames, seconds, fps: w.__frames / seconds, longest_frame_ms: w.__maxGap };
  });
}

/** Types a line into the voice box and waits for the object panel's verdict; counts frames meanwhile. */
async function typedRequest(page: Page, sent: Sent[], text: string) {
  const start = Date.now();
  await frameCounter(page);
  await page.getByTestId('voice-text').fill(text);
  await page.getByTestId('voice-text').press('Enter');
  await page.waitForFunction((t) => {
    const results = window.__sim!.voiceResults!();
    const last = results[results.length - 1];
    return last?.text === t && last.said !== null && window.__sim!.objectBusy === false;
  }, text, { timeout: 90_000 });
  const frames = await stopCounter(page);
  const end = Date.now();
  const api = sent.filter((s) => s.at >= start && s.at <= end && s.url.includes('/api/'));
  return { frames, api, wall_s: (end - start) / 1000 };
}

async function waitSimTime(page: Page, t: number): Promise<void> {
  await page.waitForFunction((until) => window.__sim!.simTime >= until, t, { timeout: 30_000 });
}

test('offline voice: object request with receipt and caption, stop with no network call, fps during a request', async ({ page }) => {
  const problems: string[] = [];
  watchProblems(page, problems);
  const sent: Sent[] = [];
  page.on('request', (request) => sent.push({ url: request.url(), at: Date.now() }));

  const health = page.waitForResponse((res) => res.url().endsWith('/api/health'), { timeout: 90_000 });
  await page.goto('/?mute=0');
  await page.waitForFunction(
    () => window.__sim?.ready === true && typeof window.__sim.voiceCommand === 'function' && typeof window.__sim.spawnObject === 'function',
    undefined,
    { timeout: 90_000 },
  );
  const healthBody = (await (await health).json()) as Record<string, unknown>;
  expect(healthBody.ok).toBe(false);
  await expect(page.getByTestId('brain-badge')).toHaveText('object brain: offline mock (no key)');
  await expect(page.getByTestId('voice-badge')).toHaveText('voice: browser (offline)');
  await expect(page.getByTestId('offline-mock')).toBeVisible();

  // 1. Typed request, through the grammar and the offline mock.
  const first = await typedRequest(page, sent, 'give me a shard of comet ice');
  await expect(page.getByTestId('object-verdict')).toHaveAttribute('data-verdict', /PASS|ADJUSTED|REFUSED/);
  const frames = first.frames;
  const apiDuringRequest = first.api;
  const verdict = await page.getByTestId('object-verdict').textContent();
  const receiptItems = await page.getByTestId('receipt-list').locator('li').count();
  const caption = (await page.getByTestId('caption').textContent()) ?? '';
  const outcome = (await page.evaluate(() => window.__sim!.lastOutcome)) as { source: string; spawned: boolean; timings: Record<string, number | null> };
  const results = await page.evaluate(() => window.__sim!.voiceResults!());
  expect(results[0]).toMatchObject({ action: { type: 'object', text: 'a shard of comet ice' }, by: 'grammar', network: false });
  expect(outcome.source).toBe('offline-mock');
  expect(receiptItems).toBeGreaterThan(3);
  expect(caption).toMatch(/simulated lift test|Refused/);
  expect(apiDuringRequest).toEqual([]);
  expect(frames.fps).toBeGreaterThanOrEqual(50);

  // 1b. A request that spawns and runs the lift test, the heavier path, for its frame rate.
  const second = await typedRequest(page, sent, 'make a Bennu-like C-type sample');
  const secondOutcome = (await page.evaluate(() => window.__sim!.lastOutcome)) as { spawned: boolean; timings: Record<string, number | null>; receipt: { verdict: string } };
  const secondCaption = (await page.getByTestId('caption').textContent()) ?? '';
  expect(second.api).toEqual([]);

  // 2. Move the arm, then "stop" by text: the latch sets at once and nothing goes on the network.
  await page.evaluate(() => window.__sim!.pickObject!());
  const moving = await page.evaluate(() => window.__sim!.simTime);
  await waitSimTime(page, moving + 1.5);
  const sentBeforeStop = sent.length;
  const stopWall = Date.now();
  await page.getByTestId('voice-text').fill('stop');
  await page.evaluate(() => {
    const w = window as unknown as { __enterAt: number | null };
    w.__enterAt = null;
    document.querySelector('[data-testid="voice-text"]')!.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') w.__enterAt = performance.now();
    }, { once: true });
  });
  await page.getByTestId('voice-text').press('Enter');
  await page.waitForFunction(() => window.__sim!.stopped === true, undefined, { timeout: 5_000 });
  const stopResult = (await page.evaluate(() => window.__sim!.voiceResults!())).at(-1)!;
  const stoppedAt = stopResult.stoppedAt!;
  const latchDelay = stoppedAt - stopResult.simTime;
  const enterToLatchMs = stopResult.stoppedAtMs! - (await page.evaluate(() => (window as unknown as { __enterAt: number }).__enterAt));
  const at0 = await page.evaluate(() => ({ t: window.__sim!.simTime, ctrl: window.__sim!.getCtrl(), q: window.__sim!.getJointPos(), site: window.__sim!.getSitePos('gripper') }));
  await waitSimTime(page, stoppedAt + 0.2);
  const at02 = await page.evaluate(() => ({ t: window.__sim!.simTime, ctrl: window.__sim!.getCtrl(), q: window.__sim!.getJointPos(), site: window.__sim!.getSitePos('gripper') }));
  await waitSimTime(page, stoppedAt + 1.2);
  const at12 = await page.evaluate(() => ({ t: window.__sim!.simTime, ctrl: window.__sim!.getCtrl(), q: window.__sim!.getJointPos(), site: window.__sim!.getSitePos('gripper') }));
  const sentDuringStop = sent.slice(sentBeforeStop).map((s) => s.url);
  const stopCaption = (await page.getByTestId('caption').textContent()) ?? '';
  const maxDiff = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));
  const siteMoveMm = at02.site && at12.site ? Math.hypot(...at02.site.map((v, i) => v - at12.site![i]!)) * 1000 : null;

  // 3. Voice cannot clear a stop.
  await page.getByTestId('voice-text').fill('resume');
  await page.getByTestId('voice-text').press('Enter');
  await expect(page.getByTestId('caption')).toContainText('Voice cannot clear a stop');
  const stillStopped = await page.evaluate(() => window.__sim!.stopped);

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's7-voice-offline.png') });
  const report = {
    health: healthBody,
    badges: await page.evaluate(() => window.__sim!.voiceBadges!()),
    request: { verdict, receiptItems, caption, source: outcome.source, spawned: outcome.spawned, timings: outcome.timings, apiCalls: apiDuringRequest.length, wall_s: first.wall_s },
    fps_during_request: frames,
    spawn_request: { verdict: secondOutcome.receipt.verdict, spawned: secondOutcome.spawned, timings: secondOutcome.timings, caption: secondCaption, apiCalls: second.api.length, wall_s: second.wall_s, fps: second.frames },
    stop: {
      latch_delay_sim_s: latchDelay,
      enter_key_to_latch_wall_ms: enterToLatchMs,
      ctrl_change_0_to_1_2s: maxDiff(at0.ctrl, at12.ctrl),
      ctrl_change_0_2_to_1_2s: maxDiff(at02.ctrl, at12.ctrl),
      joint_change_0_2_to_1_2s_rad: maxDiff(at02.q, at12.q),
      gripper_move_0_2_to_1_2s_mm: siteMoveMm,
      requests_during_stop: sentDuringStop,
      wall_ms_to_stopped: Date.now() - stopWall,
      caption: stopCaption,
    },
    resume_by_voice_left_stopped: stillStopped,
    problems,
  };
  writeFileSync(path.join(EVIDENCE_DIR, 's7-voice-offline.json'), JSON.stringify(report, null, 2));
  console.log(`S7_VOICE ${JSON.stringify(report)}`);

  expect(latchDelay).toBeLessThanOrEqual(0.2);
  expect(enterToLatchMs).toBeLessThan(200);
  expect(report.stop.ctrl_change_0_to_1_2s).toBe(0);
  expect(sentDuringStop).toEqual([]);
  expect(stopCaption).toContain('Stopped.');
  expect(stillStopped).toBe(true);
  expect(problems).toEqual([]);
  await page.evaluate(() => window.__sim!.clearStop!());
});
