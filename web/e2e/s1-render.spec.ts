import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/** web/evidence (git-ignored) unless EVIDENCE_DIR is set; playwright.config.ts sets the same default. */
const EVIDENCE_DIR = path.resolve(process.env.EVIDENCE_DIR ?? path.join(import.meta.dirname, '../evidence'));
const ARM_BODIES = ['Base', 'Rotation_Pitch', 'Upper_Arm', 'Lower_Arm', 'Wrist_Pitch_Roll', 'Fixed_Jaw', 'Moving_Jaw'];

interface PixelReport {
  variance: number;
  distinctColors: number;
  changedFromReference: number;
}

/** Decodes a PNG in the page, to avoid adding an image library to the project. */
async function analyzePng(page: Page, png: Buffer, reference?: Buffer): Promise<PixelReport> {
  return page.evaluate(
    async ([pngBase64, referenceBase64]) => {
      const decode = async (base64: string) => {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d')!;
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      };
      const pixels = await decode(pngBase64);
      const count = pixels.length / 4;
      let sum = 0;
      let sumSquares = 0;
      const colors = new Set<number>();
      for (let i = 0; i < pixels.length; i += 4) {
        const luma = 0.299 * pixels[i]! + 0.587 * pixels[i + 1]! + 0.114 * pixels[i + 2]!;
        sum += luma;
        sumSquares += luma * luma;
        colors.add((pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!);
      }
      let changed = 0;
      if (referenceBase64) {
        const other = await decode(referenceBase64);
        for (let i = 0; i < pixels.length; i += 4) {
          const delta =
            Math.abs(pixels[i]! - other[i]!) + Math.abs(pixels[i + 1]! - other[i + 1]!) + Math.abs(pixels[i + 2]! - other[i + 2]!);
          if (delta > 30) changed++;
        }
      }
      return {
        variance: sumSquares / count - (sum / count) ** 2,
        distinctColors: colors.size,
        changedFromReference: changed,
      };
    },
    [png.toString('base64'), reference?.toString('base64') ?? ''] as const,
  );
}

test('arm renders and physics runs in the browser', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
  });

  await page.goto('/');
  await page.waitForFunction(() => window.__sim?.ready === true, undefined, { timeout: 60_000 });

  // Sim time advances.
  const t0 = await page.evaluate(() => window.__sim!.simTime);
  await page.waitForTimeout(1500);
  const t1 = await page.evaluate(() => window.__sim!.simTime);
  expect(t1).toBeGreaterThan(t0);

  // Arm bodies are finite and the gripper site exists.
  const poses = await page.evaluate((names) => names.map((name) => window.__sim!.getBodyPos(name)), ARM_BODIES);
  for (const pose of poses) {
    expect(pose).not.toBeNull();
    for (const value of pose!) expect(Number.isFinite(value)).toBe(true);
  }
  const gripper = await page.evaluate(() => window.__sim!.getSitePos('gripper'));
  expect(gripper).not.toBeNull();
  for (const value of gripper!) expect(Number.isFinite(value)).toBe(true);
  expect(await page.evaluate(() => window.__sim!.getBodyPos('no_such_body'))).toBeNull();
  expect(await page.evaluate(() => window.__sim!.getJointPos().length)).toBe(6);

  // The cube rests on the floor under simulated contact: half its 3 cm height, not falling through.
  const cube = await page.evaluate(() => window.__sim!.getBodyPos('cube'));
  expect(cube![2]).toBeGreaterThan(0.013);
  expect(cube![2]).toBeLessThan(0.016);

  // The canvas is not blank.
  const canvasPng = await page.locator('#viewport canvas').screenshot();
  const canvasPixels = await analyzePng(page, canvasPng);
  console.log(`S1_PIXELS ${JSON.stringify(canvasPixels)}`);
  expect(canvasPixels.variance).toBeGreaterThan(50);
  expect(canvasPixels.distinctColors).toBeGreaterThan(100);

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's1.png') });

  // Measure performance over a window, with nothing else asked of the page.
  const measured = await page.evaluate(async () => {
    const sim = window.__sim!;
    const start = { frames: sim.renderFrames, steps: sim.physicsSteps, simTime: sim.simTime, now: performance.now() };
    const physicsMs: number[] = [];
    const end = start.now + 5000;
    await new Promise<void>((resolve) => {
      const sample = () => {
        physicsMs.push(sim.lastPhysicsMs);
        if (performance.now() >= end) resolve();
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    const seconds = (performance.now() - start.now) / 1000;
    physicsMs.sort((a, b) => a - b);
    return {
      seconds,
      fps: (sim.renderFrames - start.frames) / seconds,
      physicsStepsPerSecond: (sim.physicsSteps - start.steps) / seconds,
      realTimeFactor: (sim.simTime - start.simTime) / seconds,
      lastPhysicsMsMedian: physicsMs[Math.floor(physicsMs.length / 2)]!,
      lastPhysicsMsMax: physicsMs[physicsMs.length - 1]!,
      render: sim.renderStats(),
      crossOriginIsolated: window.crossOriginIsolated,
    };
  });
  console.log(`S1_MEASURED ${JSON.stringify(measured)}`);
  const server = process.env.E2E_SERVER === 'preview' ? 'preview' : 'dev';
  const webgl = process.env.E2E_WEBGL === 'software' ? 'software' : 'default';
  writeFileSync(path.join(EVIDENCE_DIR, `s1-measured-${server}-${webgl}.json`), JSON.stringify(measured, null, 2));
  expect(measured.fps).toBeGreaterThan(0);
  expect(measured.render.triangles).toBeGreaterThan(1000);

  // The picture follows the physics: closing the jaw moves the jaw in the sim and on screen.
  await page.evaluate(() => window.__sim!.setGrip(0));
  await page.waitForFunction(() => window.__sim!.gripperOpening() > 0.1, undefined, { timeout: 30_000 });
  const openPng = await page.locator('#viewport canvas').screenshot();
  const openGap = await page.evaluate(() => window.__sim!.gripperOpening());
  await page.evaluate(() => window.__sim!.setGrip(1));
  await page.waitForFunction(() => window.__sim!.gripperOpening() < 0.01, undefined, { timeout: 30_000 });
  const closedPng = await page.locator('#viewport canvas').screenshot();
  const closedGap = await page.evaluate(() => window.__sim!.gripperOpening());
  const difference = await analyzePng(page, closedPng, openPng);
  console.log(`S1_JAW ${JSON.stringify({ openGap, closedGap, changedPixels: difference.changedFromReference })}`);
  expect(difference.changedFromReference).toBeGreaterThan(200);

  // Dragging orbits the camera (right drag in mouse mode, where a left click works the jaw).
  // The arm is still by now, so the whole change comes from the view.
  const button = await page.evaluate(() => (window.__sim!.renderStats() as unknown as { orbitsWith?: 'left' | 'right' }).orbitsWith ?? 'left');
  await page.mouse.move(640, 360);
  await page.mouse.down({ button });
  await page.mouse.move(800, 360, { steps: 8 });
  await page.mouse.up({ button });
  await page.waitForTimeout(500);
  const orbitPng = await page.locator('#viewport canvas').screenshot();
  const orbit = await analyzePng(page, orbitPng, closedPng);
  console.log(`S1_ORBIT ${JSON.stringify({ changedPixels: orbit.changedFromReference })}`);
  expect(orbit.changedFromReference).toBeGreaterThan(1000);

  expect(problems).toEqual([]);
});
