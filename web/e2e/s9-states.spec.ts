import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { watchProblems } from './pickRun';

/** web/evidence (git-ignored) unless EVIDENCE_DIR is set; playwright.config.ts sets the same default. */
const EVIDENCE_DIR = path.resolve(process.env.EVIDENCE_DIR ?? path.join(import.meta.dirname, '../evidence'));
const STATES_DIR = path.join(EVIDENCE_DIR, 'states');
/** Must match playwright.config.ts: hand-made contexts do not inherit its baseURL. */
const BASE_URL = `http://127.0.0.1:${Number(process.env.E2E_PORT ?? 5199)}`;
const VIEW = { width: 1280, height: 720 };
/** Fake-camera clip for the hand-lost state: HAND_FRAMES of the painted hand, then empty frames, at 10 fps. */
const CLIP_FPS = 10;
const HAND_FRAMES = 10;
const EMPTY_FRAMES = 20;

/**
 * The states are tested with no key server, whatever runs on this machine: /api answers as
 * the Vite server does when nothing listens on 8787, so no Gemini or ElevenLabs call is made.
 */
async function keepOffline(context: BrowserContext): Promise<void> {
  await context.route('**/api/health', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":false}' }));
  await context.route(/\/api\/(spec|tts)/, (route) => route.fulfill({ status: 503, contentType: 'text/plain', body: 'offline in this test' }));
}

async function waitConsole(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__sim?.ready === true && typeof window.__sim.consoleState === 'function', undefined, { timeout: 90_000 });
}

/** Scrolls the console column back to its top (header, hint, mode and the ghost meter). */
async function consoleTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.getElementById('console')!.scrollTop = 0;
  });
}

/** The SIMULATION label must be on screen in every state screenshot. */
async function shoot(page: Page, name: string): Promise<void> {
  const label = page.locator('#simulation-label');
  await expect(label).toBeVisible();
  await expect(label).toContainText('SIMULATION');
  const box = (await label.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(VIEW.width);
  expect(box.y + box.height).toBeLessThanOrEqual(VIEW.height);
  await page.screenshot({ path: path.join(STATES_DIR, `${name}.png`) });
}

/** Star rotation change over one wall second. */
async function starVelocity(page: Page): Promise<number> {
  const a = await page.evaluate(() => ({ r: window.__sim!.consoleState!().starRotation!, t: performance.now() }));
  await page.waitForTimeout(1000);
  const b = await page.evaluate(() => ({ r: window.__sim!.consoleState!().starRotation!, t: performance.now() }));
  return ((b.r - a.r) * 1000) / (b.t - a.t);
}

/** Presses Tab until focus wraps, and reports which visible, enabled controls it reached. */
async function tabWalk(page: Page): Promise<{ controls: number; reached: number; missed: string[]; presses: number }> {
  const controls = await page.evaluate(() => {
    const selector = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';
    const list = [...document.querySelectorAll<HTMLElement>(selector)].filter(
      (node) => node.checkVisibility() && !(node as HTMLButtonElement).disabled,
    );
    list.forEach((node, i) => (node.dataset.tabCheck = String(i)));
    (document.activeElement as HTMLElement | null)?.blur();
    return list.length;
  });
  const reached = new Set<string>();
  let presses = 0;
  for (; presses < controls * 2 + 10; presses++) {
    await page.keyboard.press('Tab');
    const id = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.tabCheck ?? null);
    if (id !== null) reached.add(id);
    if (reached.size === controls) break;
  }
  const missed = await page.evaluate(
    (got) =>
      [...document.querySelectorAll<HTMLElement>('[data-tab-check]')]
        .filter((node) => !got.includes(node.dataset.tabCheck!))
        .map((node) => `${node.tagName.toLowerCase()} "${(node.textContent ?? node.getAttribute('aria-label') ?? '').trim().slice(0, 40)}"`),
    [...reached],
  );
  return { controls, reached: reached.size, missed, presses: presses + 1 };
}

/**
 * Contrast of every piece of visible, enabled text in the console, the strip and the labels
 * over the viewport, against its background composited from its ancestors onto the page
 * colour (text over the 3D view is checked against its own panel background, which is
 * near-opaque). Returns the lowest ratio and every element under 4.5:1.
 */
async function contrastCheck(page: Page): Promise<{ checked: number; min: number; minAt: string; fails: string[] }> {
  return page.evaluate(() => {
    type RGBA = [number, number, number, number];
    const parse = (c: string): RGBA => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return [0, 0, 0, 0];
      const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
    };
    const over = (top: RGBA, under: RGBA): RGBA => {
      const a = top[3];
      return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
    };
    const lum = (c: RGBA) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const roots = ['#console', '#loop-strip', '#simulation-label', '#status', '#hand-state', '#stop-banner', '#hand-range', '#caption-bar', '#camera-intro', '#notice']
      .map((s) => document.querySelector<HTMLElement>(s))
      .filter((n): n is HTMLElement => !!n && n.checkVisibility());
    let checked = 0;
    let min = Infinity;
    let minAt = '';
    const fails: string[] = [];
    const page0 = parse(getComputedStyle(document.body).backgroundColor);
    for (const root of roots) {
      for (const node of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
        const ownText = [...node.childNodes].some((c) => c.nodeType === Node.TEXT_NODE && c.textContent!.trim().length > 0);
        if (!ownText || !node.checkVisibility()) continue;
        if (node.closest('button:disabled, [aria-hidden="true"]')) continue;
        const chain: HTMLElement[] = [];
        for (let n: HTMLElement | null = node; n; n = n.parentElement) chain.unshift(n);
        let bg: RGBA = page0[3] > 0 ? [page0[0], page0[1], page0[2], 1] : [5, 7, 13, 1];
        let opacity = 1;
        for (const n of chain) {
          const style = getComputedStyle(n);
          opacity *= Number(style.opacity);
          const c = parse(style.backgroundColor);
          if (c[3] > 0) bg = over(c, bg);
        }
        const fg = over(parse(getComputedStyle(node).color), bg);
        const l1 = lum(fg);
        const l2 = lum(bg);
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        checked++;
        const where = `${node.tagName.toLowerCase()}${node.id ? '#' + node.id : ''}.${node.className} "${node.textContent!.trim().slice(0, 30)}" in ${root.id}`;
        if (ratio < min) {
          min = ratio;
          minAt = where;
        }
        if (ratio < 4.5 || opacity < 1) fails.push(`${ratio.toFixed(2)}:1 opacity ${opacity} ${where}`);
      }
    }
    return { checked, min, minAt, fails };
  });
}

/** The painted synthetic hand as one 4:2:0 frame (same conversion as e2e/s3-hand.spec.ts). */
async function handFrame(page: Page, palm: [number, number, number]): Promise<Buffer> {
  const yuv = await page.evaluate(async (p) => {
    const image = new Image();
    image.src = window.__sim!.syntheticHandPicture!(p, 0);
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
    for (let q = 0; q < width * height; q++) out[q] = clamp(0.299 * rgba[4 * q]! + 0.587 * rgba[4 * q + 1]! + 0.114 * rgba[4 * q + 2]!);
    const uOffset = width * height;
    const vOffset = uOffset + (width * height) / 4;
    for (let y = 0; y < height / 2; y++) {
      for (let x = 0; x < width / 2; x++) {
        let r = 0, gr = 0, b = 0;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
          const k = 4 * ((2 * y + dy) * width + 2 * x + dx);
          r += rgba[k]!; gr += rgba[k + 1]!; b += rgba[k + 2]!;
        }
        r /= 4; gr /= 4; b /= 4;
        out[uOffset + y * (width / 2) + x] = clamp(128 - 0.168736 * r - 0.331264 * gr + 0.5 * b);
        out[vOffset + y * (width / 2) + x] = clamp(128 + 0.5 * r - 0.418688 * gr - 0.081312 * b);
      }
    }
    let binary = '';
    for (let k = 0; k < out.length; k += 0x8000) binary += String.fromCharCode(...out.subarray(k, k + 0x8000));
    return btoa(binary);
  }, palm);
  return Buffer.from(yuv, 'base64');
}

test('M7 console states: screenshots, strip, Tab order, contrast, reduced motion, fps', async ({ browser }) => {
  test.setTimeout(480_000);
  mkdirSync(STATES_DIR, { recursive: true });
  const report: Record<string, unknown> = {};
  const problems: string[] = [];

  // ---- A: synthetic hand, Direct, then stopped, the G and M keys, ghost on ----
  const ctxA = await browser.newContext({ baseURL: BASE_URL, viewport: VIEW, reducedMotion: 'no-preference' });
  await keepOffline(ctxA);
  const page = await ctxA.newPage();
  watchProblems(page, problems);
  await page.goto('/?input=synthetic&speed=1&mute=1');
  await waitConsole(page);
  await page.waitForFunction(() => window.__sim!.consoleState!().slotted['object-panel'] === true, undefined, { timeout: 60_000 });
  await page.waitForTimeout(3000);

  const slotted = await page.evaluate(() => window.__sim!.consoleState!().slotted);
  report.slotted = slotted;
  for (const id of ['left-stack', 'object-panel', 'gravity-menu', 'voice-panel']) expect(slotted[id], `${id} in the console`).toBe(true);
  // Viewport left, console right.
  const viewBox = (await page.locator('#viewport canvas').boundingBox())!;
  const consoleBox = (await page.locator('#console').boundingBox())!;
  report.layout = { viewport: viewBox, console: consoleBox };
  expect(viewBox.x).toBe(0);
  expect(viewBox.x + viewBox.width).toBeLessThanOrEqual(consoleBox.x + 1);
  expect(consoleBox.x + consoleBox.width).toBeGreaterThanOrEqual(VIEW.width - 1);

  const fps = await page.evaluate(() => window.__sim!.fps);
  report.fps = fps;
  expect(fps).toBeGreaterThanOrEqual(50);
  const drift = await starVelocity(page);
  report.starVelocityRadS = drift;
  expect(drift).toBeGreaterThan(0.005);

  // The strip: live values, Act lights while the scripted hand moves the arm.
  const movingHandle = await page.waitForFunction(
    () => {
      const strip = window.__sim!.consoleState!().strip;
      return strip && strip.act.active === true && /arm moving \d+ mm\/s/.test(strip.act.text) ? strip : null;
    },
    undefined,
    { timeout: 60_000, polling: 100 },
  );
  const stripMoving = await movingHandle.jsonValue();
  report.stripMoving = stripMoving;
  expect(stripMoving!.sense.text).toContain('synthetic hand');
  expect(stripMoving!.sense.active).toBe(true);
  expect(stripMoving!.act.text).toMatch(/arm moving \d+ mm\/s/);
  expect(stripMoving!.understand.text).toContain('spec offline mock (no key)');
  await expect(page.locator('#loop-strip [data-stage]')).toHaveCount(3);

  const tab = await tabWalk(page);
  report.tab = tab;
  console.log(`S9_TAB ${JSON.stringify(tab)}`);
  expect(tab.missed).toEqual([]);
  expect(tab.reached).toBe(tab.controls);

  const contrast = await contrastCheck(page);
  report.contrastConsole = contrast;
  console.log(`S9_CONTRAST ${JSON.stringify(contrast)}`);
  expect(contrast.fails).toEqual([]);
  await consoleTop(page);
  await shoot(page, 'console');

  // G cycles gravity, M cycles mode.
  const g0 = await page.locator('[data-testid="gravity-readout"]').getAttribute('data-current');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('g');
  const g1 = await page.locator('[data-testid="gravity-readout"]').getAttribute('data-current');
  report.gKey = { before: g0, after: g1 };
  expect(g0).toBe('earth');
  expect(g1).toBe('mars');
  for (let i = 0; i < 4; i++) await page.keyboard.press('g');
  await expect(page.locator('[data-testid="gravity-readout"]')).toHaveAttribute('data-current', 'earth');

  // Stopped.
  await page.keyboard.press('Space');
  await expect(page.locator('#stop-banner')).toBeVisible();
  await page.waitForFunction(() => window.__sim!.consoleState!().strip?.act.state === 'stopped', undefined, { timeout: 5000, polling: 50 });
  const stripStopped = await page.evaluate(() => window.__sim!.consoleState!().strip);
  report.stripStopped = stripStopped;
  expect(stripStopped!.act.text).toContain('ARM STOPPED');
  expect(await page.evaluate(() => document.body.classList.contains('arm-stopped'))).toBe(true);
  report.contrastStopped = await contrastCheck(page);
  expect((report.contrastStopped as { fails: string[] }).fails).toEqual([]);
  await page.evaluate(() => (document.getElementById('console')!.scrollTop = 0));
  await shoot(page, 'stopped');
  await page.locator('#stop-clear').click();
  await expect(page.locator('#stop-banner')).toBeHidden();

  // M twice: Direct -> Moon, ghost off -> Moon, ghost on.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('m');
  await expect(page.locator('[data-delay-mode="moon_ghost_off"]')).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
  await expect(page.locator('[data-delay-mode="moon_ghost_off"]')).toBeEnabled({ timeout: 30_000 });
  await page.keyboard.press('m');
  await expect(page.locator('[data-delay-mode="moon_ghost_on"]')).toHaveAttribute('aria-pressed', 'true', { timeout: 60_000 });
  await expect(page.locator('[data-testid="error-gripper"]')).toContainText(' mm', { timeout: 30_000 });
  await page.waitForTimeout(1500);
  const ghost = await page.evaluate(() => ({ strip: window.__sim!.consoleState!().strip, meter: document.querySelector('[data-testid="error-meter"]')!.textContent, level: (document.querySelector('[data-testid="error-meter"]') as HTMLElement).dataset.level }));
  report.ghostOn = ghost;
  expect(ghost.strip!.understand.text).toMatch(/ghost err \d+\.\d mm/);
  expect(ghost.strip!.act.text).toContain('seen 1.28 s late');
  report.contrastGhost = await contrastCheck(page);
  expect((report.contrastGhost as { fails: string[] }).fails).toEqual([]);
  await consoleTop(page);
  await expect(page.locator('[data-testid="error-meter"]')).toBeInViewport();
  await shoot(page, 'ghost-on');

  // The fake-camera clip for the hand-lost state, painted by this page.
  const clip = test.info().outputPath('hand-lost.y4m');
  const frames: Buffer[] = [Buffer.from(`YUV4MPEG2 W640 H480 F${CLIP_FPS}:1 Ip A1:1 C420jpeg\n`)];
  const handYuv = await handFrame(page, [0.5, 0.55, 0.6]);
  const empty = Buffer.alloc(640 * 480 * 1.5, 128);
  empty.fill(40, 0, 640 * 480);
  for (let i = 0; i < HAND_FRAMES; i++) frames.push(Buffer.from('FRAME\n'), handYuv);
  for (let i = 0; i < EMPTY_FRAMES; i++) frames.push(Buffer.from('FRAME\n'), empty);
  mkdirSync(path.dirname(clip), { recursive: true });
  writeFileSync(clip, Buffer.concat(frames));
  await ctxA.close();

  // ---- B: mouse, a refused object ----
  const ctxB = await browser.newContext({ baseURL: BASE_URL, viewport: VIEW });
  await keepOffline(ctxB);
  const pageB = await ctxB.newPage();
  watchProblems(pageB, problems);
  await pageB.goto('/?input=mouse&mute=1');
  await waitConsole(pageB);
  await expect(pageB.locator('[data-testid="console-keys-note"]')).toBeVisible({ timeout: 10_000 });
  await pageB.locator('[data-preset="iron"]').click();
  await expect(pageB.locator('[data-testid="object-verdict"]')).toHaveAttribute('data-verdict', 'REFUSED', { timeout: 30_000 });
  const refusal = await pageB.locator('#object-panel li[data-state="refused"]').first().textContent();
  report.refusal = refusal;
  console.log(`S9_REFUSAL ${refusal}`);
  expect(refusal).toMatch(/\d+ (mm|grams|g)\b/);
  await pageB.evaluate(() => document.querySelector('#object-panel li[data-state="refused"]')!.scrollIntoView({ block: 'center' }));
  await pageB.waitForTimeout(300);
  const stripRefused = await pageB.evaluate(() => window.__sim!.consoleState!().strip);
  report.stripRefused = stripRefused;
  expect(stripRefused!.understand.text).toContain('guardrail REFUSED');
  report.contrastRefusal = await contrastCheck(pageB);
  expect((report.contrastRefusal as { fails: string[] }).fails).toEqual([]);
  await shoot(pageB, 'refusal');
  await ctxB.close();

  // ---- C: the camera screen, then camera denied (no permission granted) ----
  const ctxC = await browser.newContext({ baseURL: BASE_URL, viewport: VIEW });
  await keepOffline(ctxC);
  const pageC = await ctxC.newPage();
  watchProblems(pageC, problems);
  await pageC.goto('/?input=webcam&mute=1');
  await waitConsole(pageC);
  const intro = pageC.locator('#camera-intro');
  await expect(intro).toBeVisible({ timeout: 30_000 });
  await expect(intro).toContainText('nothing is uploaded');
  await expect(intro.getByRole('button', { name: 'Use mouse instead' })).toBeVisible();
  report.contrastIntro = await contrastCheck(pageC);
  expect((report.contrastIntro as { fails: string[] }).fails).toEqual([]);
  await shoot(pageC, 'camera-intro');
  await intro.getByRole('button', { name: 'Use camera' }).click();
  const notice = pageC.locator('#notice');
  await expect(notice).toBeVisible({ timeout: 30_000 });
  report.cameraDenied = { notice: await notice.textContent(), strip: await pageC.evaluate(() => window.__sim!.consoleState!().strip) };
  expect(await notice.textContent()).toContain('mouse');
  report.contrastDenied = await contrastCheck(pageC);
  expect((report.contrastDenied as { fails: string[] }).fails).toEqual([]);
  await shoot(pageC, 'camera-denied');
  await ctxC.close();

  // ---- D: reduced motion ----
  const ctxD = await browser.newContext({ baseURL: BASE_URL, viewport: VIEW, reducedMotion: 'reduce' });
  await keepOffline(ctxD);
  const pageD = await ctxD.newPage();
  watchProblems(pageD, problems);
  await pageD.goto('/?input=synthetic&mute=1');
  await waitConsole(pageD);
  await pageD.waitForTimeout(1000);
  const reduced = await pageD.evaluate(() => window.__sim!.consoleState!());
  const still = await starVelocity(pageD);
  report.reducedMotion = { reducedMotion: reduced.reducedMotion, starDriftRadS: reduced.starDriftRadS, measuredRadS: still };
  expect(reduced.reducedMotion).toBe(true);
  expect(still).toBe(0);
  await ctxD.close();

  // ---- E: fake camera, the hand appears and goes: hand lost, arm holding ----
  const camBrowser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${clip}`],
  });
  try {
    const ctxE = await camBrowser.newContext({ baseURL: BASE_URL, viewport: VIEW });
  await keepOffline(ctxE);
    await ctxE.grantPermissions(['camera'], { origin: BASE_URL });
    const pageE = await ctxE.newPage();
    watchProblems(pageE, problems);
    await pageE.goto('/?input=webcam&mute=1');
    await waitConsole(pageE);
    await expect(pageE.locator('#tracker-line')).toContainText('tracking warm', { timeout: 120_000 });
    await pageE.locator('#camera-intro').getByRole('button', { name: 'Use camera' }).click();
    // First a steady stream: the hand seen in several frames and the clip played past them,
    // so the lost state below comes from frames with no hand, not from the camera starting up.
    const steady = await pageE
      .waitForFunction(
        () => {
          const input = window.__sim!.input() as Record<string, number | undefined>;
          const withHand = input.framesWithHand ?? 0;
          const detections = input.detections ?? 0;
          return withHand >= 3 && detections >= 2 * withHand && detections >= 20;
        },
        undefined,
        { timeout: 90_000, polling: 100 },
      )
      .then(
        () => true,
        () => false,
      );
    const steadyInput = await pageE.evaluate(() => {
      const i = window.__sim!.input() as Record<string, unknown>;
      return { videoFrames: i.videoFrames, detections: i.detections, framesWithHand: i.framesWithHand, state: i.state, lastScore: i.lastScore };
    });
    console.log(`S9_HANDLOST_STEADY ${JSON.stringify({ steady, ...steadyInput })}`);
    expect(steady).toBe(true);
    const seen = await pageE.evaluate(
      () =>
        new Promise<{ ok: boolean; states: Record<string, number>; input: Record<string, unknown> }>((resolve) => {
          const states: Record<string, number> = {};
          const t0 = performance.now();
          const tick = () => {
            const s = window.__sim!;
            const banner = String(s.screenStates!().handState);
            states[banner] = (states[banner] ?? 0) + 1;
            const input = s.input() as Record<string, number>;
            // A detection ran on a frame with no hand within the last poll: not a stale camera.
            const fresh = typeof input.lastScore !== 'number';
            const ok = banner === 'hand lost, arm holding' && s.consoleState!().frozen === true && fresh;
            if (ok || performance.now() - t0 > 90_000) resolve({ ok, states, input: s.input() });
            else setTimeout(tick, 50);
          };
          tick();
        }),
    );
    console.log(`S9_HANDLOST_POLL ${JSON.stringify({ ok: seen.ok, states: seen.states, input: { ...seen.input, hand: undefined, mapper: undefined } })}`);
    expect(seen.ok).toBe(true);
    const lost = await pageE.evaluate(() => ({ screen: window.__sim!.screenStates!(), console: window.__sim!.consoleState!(), input: window.__sim!.input() }));
    await shoot(pageE, 'hand-lost');
    report.handLost = { screen: lost.screen, strip: lost.console.strip, frozen: lost.console.frozen, framesWithHand: lost.input.framesWithHand, detections: lost.input.detections };
    expect(lost.console.strip!.sense.state).toBe('holding');
    expect(lost.console.strip!.act.text).toContain('arm holding (hand lost)');
    expect(lost.console.strip!.sense.text).toMatch(/camera \d+ fps · tracking \d+ ms/);
    await ctxE.close();
  } finally {
    await camBrowser.close();
    rmSync(clip, { force: true });
  }

  report.problems = problems;
  writeFileSync(path.join(STATES_DIR, 's9-states.json'), JSON.stringify(report, null, 2));
  console.log(`S9_REPORT ${JSON.stringify(report)}`);
  expect(problems).toEqual([]);
});
