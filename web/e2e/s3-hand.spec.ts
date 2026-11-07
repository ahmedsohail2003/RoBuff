import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, expect, test, type Page } from '@playwright/test';
import { PICK_CRITERIA } from '../src/control/pickCheck';
import { finishRun, startRun, watchProblems } from './pickRun';

/** web/evidence (git-ignored) unless EVIDENCE_DIR is set; playwright.config.ts sets the same default. */
const EVIDENCE_DIR = path.resolve(process.env.EVIDENCE_DIR ?? path.join(import.meta.dirname, '../evidence'));
const FIXTURES = path.resolve(import.meta.dirname, 'fixtures');
/** MediaPipe's sample photo (see THIRD_PARTY.md): 640 x 960, two raised hands. */
const PHOTO = path.join(FIXTURES, 'woman_hands.jpg');
const PHOTO_URL = '/__fixtures/woman_hands.jpg';
const Y4M = path.join(FIXTURES, 'woman_hands_640x480.y4m');
/** Must match playwright.config.ts: these contexts are made by hand, so they do not inherit its baseURL. */
const BASE_URL = `http://127.0.0.1:${Number(process.env.E2E_PORT ?? 5199)}`;

async function serveFixture(page: Page): Promise<void> {
  await page.route(`**${PHOTO_URL}`, (route) => route.fulfill({ path: PHOTO, contentType: 'image/jpeg' }));
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

test('(b) HandLandmarker in the page finds 21 landmarks on the sample hand photo', async ({ page }) => {
  test.setTimeout(180_000);
  const problems: string[] = [];
  watchProblems(page, problems);
  await serveFixture(page);
  await page.goto('/?input=mouse');
  await waitReady(page);
  const result = await page.evaluate((url) => window.__sim!.detectHandsInImage(url, 2), PHOTO_URL);
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
 * Writes a Y4M clip of the photo for Chrome's fake camera. The page itself crops the
 * photo to 640 x 480 (rows 300-779, where both hands are) and converts it to 4:2:0 YUV
 * (full-range BT.601, which is what the C420jpeg tag declares). No ffmpeg needed.
 */
async function writeY4m(page: Page, frames: number): Promise<void> {
  const yuv = await page.evaluate(async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const width = 640;
    const height = 480;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d')!;
    g.drawImage(image, 0, 300, width, height, 0, 0, width, height);
    const rgba = g.getImageData(0, 0, width, height).data;
    const out = new Uint8Array(width * height * 1.5);
    const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
    for (let i = 0; i < width * height; i++) {
      out[i] = clamp(0.299 * rgba[4 * i]! + 0.587 * rgba[4 * i + 1]! + 0.114 * rgba[4 * i + 2]!);
    }
    const uOffset = width * height;
    const vOffset = uOffset + (width * height) / 4;
    for (let y = 0; y < height / 2; y++) {
      for (let x = 0; x < width / 2; x++) {
        let r = 0, gr = 0, b = 0;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
          const p = 4 * ((2 * y + dy) * width + 2 * x + dx);
          r += rgba[p]!; gr += rgba[p + 1]!; b += rgba[p + 2]!;
        }
        r /= 4; gr /= 4; b /= 4;
        out[uOffset + y * (width / 2) + x] = clamp(128 - 0.168736 * r - 0.331264 * gr + 0.5 * b);
        out[vOffset + y * (width / 2) + x] = clamp(128 + 0.5 * r - 0.418688 * gr - 0.081312 * b);
      }
    }
    let binary = '';
    for (let i = 0; i < out.length; i += 0x8000) binary += String.fromCharCode(...out.subarray(i, i + 0x8000));
    return btoa(binary);
  }, PHOTO_URL);
  const frame = Buffer.from(yuv, 'base64');
  const parts: Buffer[] = [Buffer.from('YUV4MPEG2 W640 H480 F30:1 Ip A1:1 C420jpeg\n')];
  for (let i = 0; i < frames; i++) parts.push(Buffer.from('FRAME\n'), frame);
  writeFileSync(Y4M, Buffer.concat(parts));
}

test('(c) with a fake camera playing the photo, ?input=webcam tracks a hand and reports inference time', async ({ page }) => {
  test.setTimeout(240_000);
  await serveFixture(page);
  await page.goto('/?input=mouse');
  await waitReady(page);
  rmSync(Y4M, { force: true });
  await writeY4m(page, 30);
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
    const measured = await camPage.evaluate(() => ({ input: window.__sim!.input(), hand: window.__sim!.hand(), gpu: window.__sim!.renderStats().gpu, handViewFrames: window.__sim!.handViewFrames, target: window.__sim!.target }));
    await camPage.screenshot({ path: path.join(EVIDENCE_DIR, 's3.png') });
    const input = measured.input as Record<string, unknown>;
    const summary = {
      y4mBytes,
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
    expect(input.state).toBe('running');
    expect(input.videoFrames as number).toBeGreaterThan(10);
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
