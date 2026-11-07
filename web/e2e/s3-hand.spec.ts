import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, expect, test, type Page } from '@playwright/test';
import { PICK_CRITERIA } from '../src/control/pickCheck';
import { finishRun, startRun, watchProblems } from './pickRun';

/** web/evidence (git-ignored) unless EVIDENCE_DIR is set; playwright.config.ts sets the same default. */
const EVIDENCE_DIR = path.resolve(process.env.EVIDENCE_DIR ?? path.join(import.meta.dirname, '../evidence'));
/**
 * No photograph: the camera picture is the synthetic hand's 21 landmarks painted as a
 * flat hand (src/input/drawHand.ts), made by the page at test time. The clip is git-ignored.
 */
const Y4M = path.resolve(import.meta.dirname, 'fixtures', 'synthetic_hand_640x480.y4m');
const Y4M_FRAMES = 30;
/** Must match playwright.config.ts: these contexts are made by hand, so they do not inherit its baseURL. */
const BASE_URL = `http://127.0.0.1:${Number(process.env.E2E_PORT ?? 5199)}`;
/** Open hand, palm a little below the middle of the picture, depth 0.6, swaying side to side. */
function swayPalm(frame: number): [number, number, number] {
  return [0.5 + 0.04 * Math.sin((2 * Math.PI * frame) / Y4M_FRAMES), 0.55, 0.6];
}

async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__sim?.ready === true, undefined, { timeout: 60_000 });
}

test.beforeAll(() => mkdirSync(EVIDENCE_DIR, { recursive: true }));

test('(a) the synthetic hand picks and lifts the cube through the landmark mapping, recorded to video', async ({ browser }) => {
  test.setTimeout(240_000);
  const videoDir = test.info().outputPath('video');
  const context = await browser.newContext({
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  const problems: string[] = [];
  watchProblems(page, problems);
  // Real time (speed 1), so the backup video plays at the speed a viewer would see.
  await page.goto('/?input=synthetic&speed=1');
  await waitReady(page);
  await page.waitForTimeout(1000);

  await startRun(page);
  await page.waitForFunction(() => window.__sim!.input().phase === 'hold', undefined, { timeout: 120_000 });
  await page.waitForTimeout(500);
  const atHold = await page.evaluate(() => ({
    input: window.__sim!.input(),
    hand: window.__sim!.hand(),
    cube: window.__sim!.getBodyPos('cube'),
    handViewFrames: window.__sim!.handViewFrames,
  }));
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's3-synthetic.png') });

  const report = await finishRun(page);
  await page.waitForTimeout(1000);
  const video = page.video();
  await context.close();
  if (video) await video.saveAs(path.join(EVIDENCE_DIR, 'm1-backup.webm'));

  const mapper = (atHold.input as unknown as { mapper: { framesWithHand: number; pinchClosed: boolean; lastPinchRatio: number } }).mapper;
  const summary = {
    pass: report.pass,
    failures: report.failures,
    worstWaypointMm: +(Math.max(...Object.values(report.waypointErrors)) * 1000).toFixed(2),
    waypointErrorsMm: Object.fromEntries(Object.entries(report.waypointErrors).map(([k, v]) => [k, +(v * 1000).toFixed(2)])),
    maxRiseMm: +(report.maxRise * 1000).toFixed(2),
    heldS: +report.heldS.toFixed(2),
    heldPenetrationMm: +(report.heldPenetration * 1000).toFixed(3),
    fallS: report.fallS,
    samples: report.samples,
    atHold: { mapping: atHold.input.mapping, mapper, landmarkCount: atHold.hand?.landmarks?.length ?? 0, handPinch: atHold.hand?.pinch, cube: atHold.cube, handViewFrames: atHold.handViewFrames },
    videoBytes: existsSync(path.join(EVIDENCE_DIR, 'm1-backup.webm')) ? statSync(path.join(EVIDENCE_DIR, 'm1-backup.webm')).size : 0,
  };
  console.log(`S3_SYNTHETIC_PICK ${JSON.stringify(summary)}`);
  writeFileSync(path.join(EVIDENCE_DIR, 's3-synthetic-pick.json'), JSON.stringify(summary, null, 2));

  // The path is the landmark one: 21 points through the HandMapper, pinch latched closed while held.
  expect(atHold.input.mapping).toBe('landmarks -> HandMapper');
  expect(atHold.hand?.landmarks).toHaveLength(21);
  expect(mapper.framesWithHand).toBeGreaterThan(100);
  expect(mapper.pinchClosed).toBe(true);
  expect(atHold.handViewFrames).toBeGreaterThan(0);
  // Same assertions as S2.
  expect(report.failures).toEqual([]);
  for (const error of Object.values(report.waypointErrors)) expect(error).toBeLessThan(PICK_CRITERIA.waypointTolerance);
  expect(report.maxRise).toBeGreaterThanOrEqual(PICK_CRITERIA.minRise);
  expect(report.heldS).toBeGreaterThanOrEqual(PICK_CRITERIA.minHoldS);
  expect(report.heldPenetration).toBeLessThanOrEqual(PICK_CRITERIA.maxPenetration);
  expect(report.fallS).not.toBeNull();
  expect(summary.videoBytes).toBeGreaterThan(0);
  expect(problems).toEqual([]);
});

test('(b) HandLandmarker in the page finds 21 landmarks on the painted synthetic hand', async ({ page }) => {
  test.setTimeout(180_000);
  const problems: string[] = [];
  watchProblems(page, problems);
  await page.goto('/?input=mouse');
  await waitReady(page);
  const result = await page.evaluate((palm) => window.__sim!.detectHandsInImage(window.__sim!.syntheticHandPicture!(palm, 0), 2), swayPalm(0));
  console.log(`S3_IMAGE ${JSON.stringify(result)}`);
  writeFileSync(path.join(EVIDENCE_DIR, 's3-image.json'), JSON.stringify(result, null, 2));
  expect(result.imageWidth).toBe(640);
  expect(result.hands.length).toBeGreaterThanOrEqual(1);
  for (const hand of result.hands) {
    expect(hand.landmarkCount).toBe(21);
    expect(hand.finite).toBe(true);
    expect(hand.score).toBeGreaterThan(0.5);
  }
  expect(problems).toEqual([]);
});

/**
 * Writes a Y4M clip for Chrome's fake camera: Y4M_FRAMES frames of the painted synthetic
 * hand, swaying, each converted by the page to 4:2:0 YUV (full-range BT.601, which is what
 * the C420jpeg tag declares). No photograph and no ffmpeg needed.
 */
async function writeY4m(page: Page): Promise<void> {
  const parts: Buffer[] = [Buffer.from('YUV4MPEG2 W640 H480 F30:1 Ip A1:1 C420jpeg\n')];
  for (let i = 0; i < Y4M_FRAMES; i++) {
    const yuv = await page.evaluate(async (palm) => {
      const image = new Image();
      image.src = window.__sim!.syntheticHandPicture!(palm, 0);
      await image.decode();
      const width = 640;
      const height = 480;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext('2d')!;
      g.drawImage(image, 0, 0);
      const rgba = g.getImageData(0, 0, width, height).data;
      const out = new Uint8Array(width * height * 1.5);
      const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
      for (let p = 0; p < width * height; p++) {
        out[p] = clamp(0.299 * rgba[4 * p]! + 0.587 * rgba[4 * p + 1]! + 0.114 * rgba[4 * p + 2]!);
      }
      const uOffset = width * height;
      const vOffset = uOffset + (width * height) / 4;
      for (let y = 0; y < height / 2; y++) {
        for (let x = 0; x < width / 2; x++) {
          let r = 0, gr = 0, b = 0;
          for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
            const q = 4 * ((2 * y + dy) * width + 2 * x + dx);
            r += rgba[q]!; gr += rgba[q + 1]!; b += rgba[q + 2]!;
          }
          r /= 4; gr /= 4; b /= 4;
          out[uOffset + y * (width / 2) + x] = clamp(128 - 0.168736 * r - 0.331264 * gr + 0.5 * b);
          out[vOffset + y * (width / 2) + x] = clamp(128 + 0.5 * r - 0.418688 * gr - 0.081312 * b);
        }
      }
      let binary = '';
      for (let k = 0; k < out.length; k += 0x8000) binary += String.fromCharCode(...out.subarray(k, k + 0x8000));
      return btoa(binary);
    }, swayPalm(i));
    parts.push(Buffer.from('FRAME\n'), Buffer.from(yuv, 'base64'));
  }
  mkdirSync(path.dirname(Y4M), { recursive: true });
  writeFileSync(Y4M, Buffer.concat(parts));
}

test('(c) with a fake camera playing the painted hand, ?input=webcam warms up, tracks a hand and reports inference time', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?input=mouse');
  await waitReady(page);
  rmSync(Y4M, { force: true });
  await writeY4m(page);
  const y4mBytes = statSync(Y4M).size;

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${Y4M}`],
  });
  try {
    const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1280, height: 720 } });
    await context.grantPermissions(['camera'], { origin: BASE_URL });
    const camPage = await context.newPage();
    const problems: string[] = [];
    watchProblems(camPage, problems);
    const loadStart = Date.now();
    await camPage.goto('/?input=webcam');
    await waitReady(camPage);
    // The start screen comes first: it says why the camera is wanted and warms the model up.
    const intro = camPage.locator('#camera-intro');
    await expect(intro).toBeVisible({ timeout: 30_000 });
    const introText = await intro.textContent();
    await expect(camPage.locator('#tracker-line')).toContainText('tracking warm', { timeout: 120_000 });
    const warmLine = await camPage.locator('#tracker-line').textContent();
    const beforeConsent = await camPage.evaluate(() => window.__sim!.input());
    await intro.getByRole('button', { name: 'Use camera' }).click();
    await camPage.waitForFunction(
      () => {
        const input = window.__sim!.input() as Record<string, unknown>;
        if (input.state === 'denied' || input.state === 'no-camera' || input.state === 'error') return true;
        const hand = window.__sim!.hand();
        return input.state === 'running' && (input.inferenceSamples as number) >= 30 && !!hand && hand.confidence > 0.5;
      },
      undefined,
      { timeout: 180_000, polling: 250 },
    );
    const firstHandMs = Date.now() - loadStart;
    // Let it run a few more seconds to collect a steady timing window.
    await camPage.waitForTimeout(3000);
    const measured = await camPage.evaluate(() => ({
      input: window.__sim!.input(),
      hand: window.__sim!.hand(),
      gpu: window.__sim!.renderStats().gpu,
      handViewFrames: window.__sim!.handViewFrames,
      target: window.__sim!.target,
      smoothed: window.__sim!.controller().smoothed,
      screen: window.__sim!.screenStates!(),
    }));
    await camPage.screenshot({ path: path.join(EVIDENCE_DIR, 's3.png') });
    const input = measured.input as Record<string, unknown>;
    const detections = input.detections as number;
    const framesWithHand = input.framesWithHand as number;
    const summary = {
      y4mBytes,
      y4mFrames: Y4M_FRAMES,
      introText,
      warmLine,
      stateBeforeConsent: beforeConsent.state,
      warmupMs: input.warmupMs,
      trackerState: input.trackerState,
      numHands: input.numHands,
      handFraction: detections > 0 ? +(framesWithHand / detections).toFixed(4) : 0,
      screen: measured.screen,
      smoothedTarget: measured.smoothed,
      state: input.state,
      message: input.message,
      delegate: input.delegate,
      gpuError: input.gpuError,
      webglRenderer: measured.gpu,
      modelLoadMs: input.modelLoadMs,
      video: `${String(input.videoWidth)}x${String(input.videoHeight)}`,
      videoFrames: input.videoFrames,
      detections: input.detections,
      framesWithHand: input.framesWithHand,
      firstDetectionMs: input.firstDetectionMs,
      medianInferenceMs: input.medianInferenceMs,
      lastInferenceMs: input.lastInferenceMs,
      maxInferenceMs: input.maxInferenceMs,
      inferenceSamples: input.inferenceSamples,
      wallMsToFirstConfidentHand: firstHandMs,
      hand: measured.hand ? { palm: measured.hand.palm, pinch: measured.hand.pinch, pinchRatio: measured.hand.pinchRatio, confidence: measured.hand.confidence, landmarks: measured.hand.landmarks?.length } : null,
      armTarget: measured.target,
      handViewFrames: measured.handViewFrames,
    };
    console.log(`S3_WEBCAM ${JSON.stringify(summary)}`);
    writeFileSync(path.join(EVIDENCE_DIR, 's3-webcam.json'), JSON.stringify(summary, null, 2));
    expect(introText).toContain('nothing is uploaded');
    expect(beforeConsent.state).toBe('idle');
    expect(input.state).toBe('running');
    expect(input.trackerState).toBe('warm');
    expect(input.numHands).toBe(1);
    expect(typeof input.warmupMs).toBe('number');
    expect(input.videoFrames as number).toBeGreaterThan(10);
    // A hand in at least 90% of the frames the tracker ran on.
    expect(framesWithHand / detections).toBeGreaterThanOrEqual(0.9);
    // While the hand is tracked there is no hand-lost line; the range line is on screen.
    expect(measured.screen.handState).toBeNull();
    expect(measured.screen.stopBanner).toBeNull();
    await expect(camPage.locator('#stop-banner')).toBeHidden();
    expect(measured.screen.handRange).toContain('hand range');
    expect(measured.screen.status).toMatch(/tracking \d+ ms \| physics [\d.]+ ms \| \d+ fps \| grip (open|closed)/);
    expect(measured.hand?.landmarks).toHaveLength(21);
    expect(measured.hand!.confidence).toBeGreaterThan(0.5);
    expect(typeof input.medianInferenceMs).toBe('number');
    expect(measured.target).not.toBeNull();
    expect(problems).toEqual([]);
    await context.close();
  } finally {
    await browser.close();
  }
});

test('(d) with no usable camera, ?input=webcam says so and offers the mouse', async ({ page }) => {
  // Playwright grants no permissions by default, so getUserMedia is refused (or finds no device).
  await page.goto('/?input=webcam');
  await waitReady(page);
  await page.locator('#camera-intro').getByRole('button', { name: 'Use camera' }).click();
  const notice = page.locator('#notice');
  await expect(notice).toBeVisible({ timeout: 30_000 });
  const text = await notice.textContent();
  console.log(`S3_NO_CAMERA ${JSON.stringify({ text, input: await page.evaluate(() => window.__sim!.input()) })}`);
  expect(text).toContain('mouse');
  await notice.getByRole('button', { name: 'Use mouse instead' }).click();
  await expect(notice).toHaveCount(0);
  expect(await page.evaluate(() => window.__sim!.input().kind)).toBe('mouse');
  await expect(page.locator('#status')).toContainText('mouse');
});

test('(e) Space stops the arm: the latch holds every actuator command for 2 s until Resume', async ({ page }) => {
  test.setTimeout(180_000);
  const problems: string[] = [];
  watchProblems(page, problems);
  await page.goto('/?input=synthetic&speed=1');
  await waitReady(page);
  await startRun(page);
  // Stop mid-lift: the arm is moving and the jaw is closed on the cube.
  await page.waitForFunction(() => window.__sim!.input().phase === 'lift', undefined, { timeout: 120_000 });
  await page.waitForTimeout(400);
  await page.keyboard.press('Space');
  const atStop = await page.evaluate(() => ({ stopped: window.__sim!.stopped, ctrl: window.__sim!.getCtrl(), t: window.__sim!.simTime, screen: window.__sim!.screenStates!() }));
  const samples: { t: number; ctrl: number[]; stopped: boolean | undefined }[] = [];
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(250);
    samples.push(await page.evaluate(() => ({ t: window.__sim!.simTime, ctrl: window.__sim!.getCtrl(), stopped: window.__sim!.stopped })));
  }
  // A second Space while stopped changes nothing.
  await page.keyboard.press('Space');
  const afterSecondSpace = await page.evaluate(() => ({ stopped: window.__sim!.stopped, ctrl: window.__sim!.getCtrl() }));
  const cubeDuringStop = await page.evaluate(() => window.__sim!.getBodyPos('cube'));
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 'm1-stop.png') });
  await page.locator('#stop-banner').getByRole('button', { name: 'Resume' }).click();
  await page.waitForTimeout(1000);
  const afterResume = await page.evaluate(() => ({ stopped: window.__sim!.stopped, ctrl: window.__sim!.getCtrl(), phase: window.__sim!.input().phase, screen: window.__sim!.screenStates!() }));

  const maxCtrlChange = Math.max(...samples.flatMap((sample) => sample.ctrl.map((value, i) => Math.abs(value - atStop.ctrl[i]!))));
  const resumeChange = Math.max(...afterResume.ctrl.map((value, i) => Math.abs(value - atStop.ctrl[i]!)));
  const summary = {
    stoppedAt: atStop.t,
    heldSimS: +(samples.at(-1)!.t - atStop.t).toFixed(3),
    samples: samples.length,
    maxCtrlChange,
    ctrlAtStop: atStop.ctrl,
    stopBanner: atStop.screen.stopBanner,
    statusAtStop: atStop.screen.status,
    afterSecondSpace: afterSecondSpace.stopped,
    cubeDuringStop,
    afterResume: { stopped: afterResume.stopped, phase: afterResume.phase, maxCtrlChange: resumeChange, stopBanner: afterResume.screen.stopBanner },
  };
  console.log(`M1_STOP ${JSON.stringify(summary)}`);
  writeFileSync(path.join(EVIDENCE_DIR, 'm1-stop.json'), JSON.stringify(summary, null, 2));

  expect(atStop.stopped).toBe(true);
  expect(atStop.screen.stopBanner).toContain('STOPPED');
  expect(atStop.screen.status).toContain('STOPPED');
  // Physics kept running for 2 s of simulated time while no command changed, jaw included.
  expect(samples.at(-1)!.t - atStop.t).toBeGreaterThanOrEqual(1.9);
  for (const sample of samples) {
    expect(sample.stopped).toBe(true);
    expect(sample.ctrl).toEqual(atStop.ctrl);
  }
  expect(afterSecondSpace.stopped).toBe(true);
  expect(afterSecondSpace.ctrl).toEqual(atStop.ctrl);
  // Resume clears the latch and the hand drives the arm again.
  expect(afterResume.stopped).toBe(false);
  expect(afterResume.screen.stopBanner).toBeNull();
  await expect(page.locator('#stop-banner')).toBeHidden();
  expect(resumeChange).toBeGreaterThan(0);
  expect(problems).toEqual([]);
});
