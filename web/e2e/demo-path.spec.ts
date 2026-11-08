// M9c-early demo path: the PLAN §8 run, recorded, with scripted input (synthetic hand and a
// Playwright mouse; no person in the loop). Direct pick -> Moon miss (the jaw closes with the
// rock more than 30 mm away) -> ghost pick -> "give me a Bennu sample" through the voice hook
// -> "an asteroid the size of Texas" refused at full size -> release at Bennu gravity -> the
// results slide -> the disclosure slide. Three app loads (synthetic, mouse, synthetic) and two
// slides in one page, so one video: $EVIDENCE_DIR/demo-path.webm,
// plus demo-*.png screenshots and demo-path.json (beat times for the captions, measurements).
// The object requests go to live Gemini when the key server's /api/health says so, else to the
// offline mock; the receipt records which. Every page load uses ?mute=1 (the video is silent).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { finishRun, startRun, watchProblems } from './pickRun';

/** web/evidence (git-ignored) unless EVIDENCE_DIR is set; playwright.config.ts sets the same default. */
const EVIDENCE_DIR = path.resolve(process.env.EVIDENCE_DIR ?? path.join(import.meta.dirname, '../evidence'));
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SLIDES_URL = pathToFileURL(path.join(ROOT, 'slides', 'index.html')).href;
/** The backup video is 1920x1080, so the page is recorded at that size. */
const VIEW = { width: 1920, height: 1080 };
const SPEED = 3;
/** Extra wall time at the end of the short beats, so a burned-in caption can be read. */
const HOLD_MS = 2000;
type V3 = [number, number, number];

interface Beat {
  id: string;
  start_s: number;
  end_s: number;
  /** The beat opened with a page load, so the video shows a cut there (the caption script aligns on it). */
  nav: boolean;
}

interface FpsSample {
  wall_s: number;
  fps: number;
}

const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return NaN;
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

async function openApp(page: Page, query: string): Promise<void> {
  await page.goto(`/?${query}&speed=${SPEED}&mute=1&persist=0`);
  await page.waitForFunction(
    () => window.__sim?.ready === true && typeof window.__sim.setDelayMode === 'function' && typeof window.__sim.spawnObject === 'function' && typeof window.__sim.voiceCommand === 'function',
    undefined,
    { timeout: 90_000 },
  );
  // The app's own fps, twice a second, kept in the page until collected.
  await page.evaluate(() => {
    const w = window as unknown as { __fps: { wall: number; fps: number }[] };
    w.__fps = [];
    setInterval(() => w.__fps.push({ wall: performance.now(), fps: window.__sim!.fps }), 500);
  });
}

/** fps samples taken more than 2 s after the page loaded (the first second's counter is still filling). */
async function collectFps(page: Page): Promise<FpsSample[]> {
  const raw = await page.evaluate(() => (window as unknown as { __fps: { wall: number; fps: number }[] }).__fps);
  return raw.filter((s) => s.wall > 2000 && s.fps > 0).map((s) => ({ wall_s: s.wall / 1000, fps: s.fps }));
}

async function waitSimTime(page: Page, t: number, timeout = 60_000): Promise<void> {
  await page.waitForFunction((until) => window.__sim!.simTime >= until, t, { timeout });
}

/**
 * Chrome's screencast only sends a frame when the page repaints, and a static slide never does, so
 * the recording would keep the last app frame. A 2 px corner dot that changes shade every frame
 * (invisible on the dark slide) keeps frames coming. Test-only; the slide files are unchanged.
 */
async function keepPainting(page: Page): Promise<void> {
  await page.evaluate(() => {
    const dot = document.createElement('div');
    dot.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;pointer-events:none;z-index:2147483647';
    document.body.appendChild(dot);
    let on = false;
    const tick = () => {
      on = !on;
      dot.style.background = on ? 'rgba(0,0,0,0.02)' : 'rgba(0,0,0,0.04)';
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function pressMode(page: Page, mode: 'direct' | 'moon_ghost_off' | 'moon_ghost_on'): Promise<void> {
  const button = page.locator(`[data-delay-mode="${mode}"]`);
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
}

test('demo path: direct pick, Moon miss, ghost pick, Bennu sample, Texas refusal, Bennu release, results, recorded', async ({ browser, baseURL }) => {
  test.setTimeout(420_000);
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const rawDir = path.join(EVIDENCE_DIR, 'demo-path-raw');
  rmSync(rawDir, { recursive: true, force: true });
  const context = await browser.newContext({ baseURL, viewport: VIEW, recordVideo: { dir: rawDir, size: VIEW } });
  // The three-line first-run hint is for people; the recording starts with it dismissed.
  await context.addInitScript(() => {
    try {
      localStorage.setItem('aftergrip-first-run-hint-seen', '1');
    } catch {
      // file:// pages may refuse storage; the slides do not read it.
    }
  });
  const page = await context.newPage();
  const t0 = Date.now();
  const now = () => (Date.now() - t0) / 1000;
  const problems: string[] = [];
  watchProblems(page, problems);
  const beats: Beat[] = [];
  let beatStart = 0;
  const navBeats = new Set(['moon_miss', 'ghost_pick', 'results']);
  const endBeat = (id: string) => {
    const end = now();
    beats.push({ id, start_s: Number(beatStart.toFixed(2)), end_s: Number(end.toFixed(2)), nav: navBeats.has(id) });
    beatStart = end;
  };
  const shot = (name: string) => page.screenshot({ path: path.join(EVIDENCE_DIR, `demo-${name}.png`) });
  const fps: Record<string, FpsSample[]> = {};
  const report: Record<string, unknown> = { speed: SPEED, view: VIEW, input: 'scripted: synthetic hand and a Playwright mouse; no person' };

  // 1. Direct: the scripted virtual hand picks the 30 mm rock by friction.
  await openApp(page, 'input=synthetic');
  await startRun(page);
  await page.waitForFunction(() => window.__sim!.input().phase === 'hold', undefined, { timeout: 60_000 });
  await shot('1-direct');
  const direct = await finishRun(page);
  report.direct = { pass: direct.pass, maxRise_mm: direct.maxRise * 1000, held_s: direct.heldS };
  console.log(`DEMO_DIRECT ${JSON.stringify(report.direct)}`);
  expect(direct.maxRise).toBeGreaterThanOrEqual(0.048);
  fps.direct = await collectFps(page);
  await page.waitForTimeout(HOLD_MS);

  // 2. Moon, ghost off, with the mouse: pinch at once. The command reaches the arm 1.28 s later and
  // the screen shows it 2.56 s later; the jaw closes where the arm is, not on the rock. Run at
  // speed 1 so the wait is real time on the video.
  // A beat ends when the next page has loaded, so its caption stays with its own picture.
  await openApp(page, 'input=mouse');
  endBeat('direct');
  await pressMode(page, 'moon_ghost_off');
  await page.evaluate(() => (window.__sim!.speed = 1));
  const view = (await page.locator('#viewport').boundingBox())!;
  await page.mouse.move(view.x + view.width * 0.5, view.y + view.height * 0.45, { steps: 8 });
  await page.evaluate(() => {
    const w = window as unknown as { __miss: { pressT: number | null; samples: unknown[]; rest: number } };
    const sim = window.__sim!;
    w.__miss = { pressT: null, samples: [], rest: sim.delayState!().truthRock![2] };
    window.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() === 'g' && w.__miss.pressT === null) w.__miss.pressT = sim.simTime;
    });
    const loop = () => {
      const s = sim.delayState!();
      w.__miss.samples.push({ t: s.simTime, grip: sim.controller().grip ?? 0, truth: s.truthGripper, seen: s.seenGripper, rock: s.truthRock });
      if (w.__miss.samples.length < 100_000) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  await page.waitForTimeout(600);
  await page.keyboard.press('g');
  const pressT = await page.evaluate(() => (window as unknown as { __miss: { pressT: number } }).__miss.pressT);
  // 3 s after the pinch the screen (2.56 s behind) shows the jaw closed on nothing.
  await waitSimTime(page, pressT + 3.0);
  await shot('2-moon-miss');
  await waitSimTime(page, pressT + 4.5);
  const miss = await page.evaluate(() => {
    const w = window as unknown as { __miss: { pressT: number; rest: number; samples: { t: number; grip: number; truth: V3; seen: V3; rock: V3 }[] } };
    return w.__miss;
  });
  const closing = miss.samples.find((s) => s.t > miss.pressT && s.grip >= 0.5)!;
  expect(closing).toBeDefined();
  const missReport = {
    pressed_at_sim_s: miss.pressT,
    truth_jaw_closes_after_s: closing.t - miss.pressT,
    gripper_to_rock_at_close_mm: dist(closing.truth, closing.rock) * 1000,
    rock_max_rise_mm: Math.max(...miss.samples.map((s) => s.rock[2] - miss.rest)) * 1000,
  };
  report.moonMiss = missReport;
  console.log(`DEMO_MOON_MISS ${JSON.stringify(missReport)}`);
  expect(missReport.truth_jaw_closes_after_s).toBeGreaterThanOrEqual(1.2);
  expect(missReport.gripper_to_rock_at_close_mm).toBeGreaterThan(30);
  expect(missReport.rock_max_rise_mm).toBeLessThan(5);
  fps.moon_miss = await collectFps(page);
  await page.waitForTimeout(HOLD_MS);

  // 3. Moon, ghost on: the scripted hand's pick (a fresh synthetic page: pickObject has no plan for
  // the arena rock, only for spawned objects). The ghost answers now, the true arm 1.28 s later.
  await openApp(page, 'input=synthetic');
  endBeat('moon_miss');
  await pressMode(page, 'moon_ghost_on');
  await page.evaluate(() => {
    const w = window as unknown as { __ghost: { samples: unknown[]; rest: number; doneT: number | null } };
    const sim = window.__sim!;
    w.__ghost = { samples: [], rest: sim.delayState!().truthRock![2], doneT: null };
    const loop = () => {
      const s = sim.delayState!();
      w.__ghost.samples.push({ t: s.simTime, rockZ: s.truthRock![2] - w.__ghost.rest, ghostVisible: s.ghostVisible, errorMm: s.error ? s.error.gripper_mm : null, level: s.error?.level ?? null });
      if (w.__ghost.doneT === null && sim.input().done) w.__ghost.doneT = s.simTime;
      if (w.__ghost.doneT === null || s.simTime < w.__ghost.doneT + 1.6) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  await page.waitForFunction(() => window.__sim!.simTime > 5.5, undefined, { timeout: 60_000 });
  await shot('3-ghost');
  await page.waitForFunction(
    () => {
      const g = (window as unknown as { __ghost: { doneT: number | null } }).__ghost;
      return g.doneT !== null && window.__sim!.simTime >= g.doneT + 1.6;
    },
    undefined,
    { timeout: 90_000 },
  );
  const ghost = await page.evaluate(() => (window as unknown as { __ghost: { samples: { rockZ: number; ghostVisible: boolean; errorMm: number | null; level: string | null }[] } }).__ghost.samples);
  const ghostErrors = ghost.filter((s) => s.errorMm !== null).map((s) => s.errorMm!);
  const ghostReport = {
    truth_rock_max_rise_mm: Math.max(...ghost.map((s) => s.rockZ)) * 1000,
    ghost_visible: ghost.some((s) => s.ghostVisible),
    meter_max_mm: ghostErrors.length ? Math.max(...ghostErrors) : null,
    meter_levels: [...new Set(ghost.map((s) => s.level).filter(Boolean))],
  };
  report.ghostPick = ghostReport;
  console.log(`DEMO_GHOST_PICK ${JSON.stringify(ghostReport)}`);
  expect(ghostReport.ghost_visible).toBe(true);
  expect(ghostReport.truth_rock_max_rise_mm).toBeGreaterThanOrEqual(48);
  fps.moon = await collectFps(page);
  await page.waitForTimeout(HOLD_MS);
  endBeat('ghost_pick');

  // 4. Back to Direct; "give me a Bennu sample" through the voice hook. Gemini or the offline mock
  // proposes the spec (the receipt says which); the checks and the headless lift test decide.
  await pressMode(page, 'direct');
  const fpsMark = await page.evaluate(() => performance.now() / 1000);
  const health = await page.evaluate(() => fetch('/api/health').then((r) => r.json()).catch(() => ({ ok: false })));
  const bennuCmd = await page.evaluate(() => window.__sim!.voiceCommand!('give me a Bennu sample'));
  await page.waitForFunction(() => window.__sim!.objectBusy === false, undefined, { timeout: 90_000 });
  const bennu = (await page.evaluate(() => window.__sim!.lastOutcome)) as { source: string; spawned: boolean; receipt: { verdict: string; mass_kg: number | null } };
  const brainBadge = await page.getByTestId('brain-badge').textContent();
  report.bennuSample = { health_ok: (health as { ok: boolean }).ok, by: bennuCmd.by, action: bennuCmd.action, source: bennu.source, verdict: bennu.receipt.verdict, mass_g: bennu.receipt.mass_kg === null ? null : bennu.receipt.mass_kg * 1000, spawned: bennu.spawned, brainBadge };
  console.log(`DEMO_BENNU_SAMPLE ${JSON.stringify(report.bennuSample)}`);
  expect(bennuCmd.action.type).toBe('object');
  expect(bennu.source).toBe((health as { ok: boolean }).ok ? 'gemini' : 'offline-mock');
  await expect(page.getByTestId('object-verdict')).toHaveAttribute('data-verdict', /PASS|ADJUSTED|REFUSED/);
  await shot('4-bennu-sample');
  await page.waitForTimeout(2500);
  endBeat('bennu_sample');

  // 5. "An asteroid the size of Texas": refused at full size with numbers, then rescaled and lift-tested.
  const texasCmd = await page.evaluate(() => window.__sim!.voiceCommand!('make an asteroid the size of Texas'));
  await page.waitForFunction(() => window.__sim!.objectBusy === false, undefined, { timeout: 90_000 });
  const texas = (await page.evaluate(() => window.__sim!.lastOutcome)) as { source: string; spawned: boolean; stages: { code: string; state: string; text: string }[]; receipt: { verdict: string } };
  const wide = texas.stages.find((s) => s.code === 'TOO_WIDE');
  report.texas = { by: texasCmd.by, source: texas.source, verdict: texas.receipt.verdict, spawned: texas.spawned, tooWide: wide ?? null };
  console.log(`DEMO_TEXAS ${JSON.stringify(report.texas)}`);
  expect(wide).toBeDefined();
  expect(wide!.text).toMatch(/millimetres/);
  await expect(page.getByTestId('object-verdict')).toHaveAttribute('data-verdict', /ADJUSTED|REFUSED/);
  await shot('5-texas');
  await page.waitForTimeout(2500);
  endBeat('texas_refusal');

  // 6. Bennu gravity: the scripted hand picks whatever the slot holds and lets go; it barely falls.
  await page.click('[data-gravity="bennu"]');
  await expect(page.getByTestId('gravity-readout')).toContainText('Bennu');
  const body = await page.evaluate(() => window.__sim!.objectBodyName!);
  await page.evaluate((name) => {
    const w = window as unknown as { __drift: { samples: unknown[]; rest: number; doneT: number | null; openT: number | null } };
    const sim = window.__sim!;
    sim.pickObject!();
    w.__drift = { samples: [], rest: sim.getBodyPos(name)![2], doneT: null, openT: null };
    const loop = () => {
      const input = sim.input();
      if (w.__drift.openT === null && input.phase === 'open') w.__drift.openT = sim.simTime;
      if (w.__drift.doneT === null && input.done) w.__drift.doneT = sim.simTime;
      w.__drift.samples.push({ t: sim.simTime, z: sim.getBodyPos(name)![2] - w.__drift.rest, pos: sim.getBodyPos(name), escape: sim.escape!() });
      if (w.__drift.doneT === null || sim.simTime < w.__drift.doneT + 6) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }, body);
  await page.waitForFunction(() => window.__sim!.input().phase === 'move', undefined, { timeout: 60_000 });
  await page.waitForFunction(
    () => {
      const d = (window as unknown as { __drift: { doneT: number | null } }).__drift;
      return d.doneT !== null && window.__sim!.simTime >= d.doneT + 3;
    },
    undefined,
    { timeout: 90_000 },
  );
  await shot('6-bennu-release');
  await page.waitForFunction(
    () => {
      const d = (window as unknown as { __drift: { doneT: number | null } }).__drift;
      return d.doneT !== null && window.__sim!.simTime >= d.doneT + 6;
    },
    undefined,
    { timeout: 90_000 },
  );
  const drift = await page.evaluate(() => (window as unknown as { __drift: { openT: number; doneT: number; samples: { t: number; z: number; pos: V3; escape: unknown }[] } }).__drift);
  const atOpen = drift.samples.find((s) => s.t >= drift.openT)!;
  const last = drift.samples[drift.samples.length - 1]!;
  const driftReport = {
    body,
    max_rise_mm: Math.max(...drift.samples.map((s) => s.z)) * 1000,
    height_at_release_mm: atOpen.z * 1000,
    height_after_s: last.t - drift.openT,
    height_then_mm: last.z * 1000,
    moved_since_release_mm: dist(last.pos, atOpen.pos) * 1000,
    escape_readout: last.escape,
  };
  report.bennuRelease = driftReport;
  console.log(`DEMO_BENNU_RELEASE ${JSON.stringify(driftReport)}`);
  expect(driftReport.height_at_release_mm).toBeGreaterThan(30);
  // At Bennu gravity a released body is still well off the floor seconds later.
  expect(driftReport.height_then_mm).toBeGreaterThan(20);
  fps.objects_and_bennu = (await collectFps(page)).filter((s) => s.wall_s > fpsMark);

  // 7. Results: the slide says "not yet measured" while it is marked pending (no ghost verdict yet).
  // The beat starts once the slide shows.
  await page.goto(`${SLIDES_URL}#8`);
  const results = page.locator('#s-results');
  await expect(results).toBeVisible();
  await keepPainting(page);
  endBeat('bennu_release');
  const pending = (await results.getAttribute('data-results')) === 'pending';
  if (pending) await expect(results).toContainText('not yet measured');
  else await expect(results).not.toContainText('not yet measured');
  report.results = { pending };
  await shot('7-results');
  await page.waitForTimeout(6000);

  // 8. Close: the disclosure slide.
  await page.goto(`${SLIDES_URL}#9`);
  await expect(page.locator('#s-disclosure')).toBeVisible();
  endBeat('results');
  await shot('8-disclosure');
  await page.waitForTimeout(6000);
  endBeat('close');

  await context.close();
  const video = page.video()!;
  const videoPath = path.join(EVIDENCE_DIR, 'demo-path.webm');
  await video.saveAs(videoPath);
  await video.delete();
  rmSync(rawDir, { recursive: true, force: true });

  const appFps = [...fps.direct!, ...fps.moon_miss!, ...fps.moon!, ...fps.objects_and_bennu!].map((s) => s.fps);
  const fpsReport = {
    median_all: median(appFps),
    median_direct: median(fps.direct!.map((s) => s.fps)),
    median_moon_miss: median(fps.moon_miss!.map((s) => s.fps)),
    median_moon_ghost: median(fps.moon!.map((s) => s.fps)),
    median_objects_and_bennu: median(fps.objects_and_bennu!.map((s) => s.fps)),
    min: Math.min(...appFps),
    samples: appFps.length,
  };
  report.fps = fpsReport;
  const duration = beats[beats.length - 1]!.end_s;
  console.log(`DEMO_FPS ${JSON.stringify(fpsReport)}`);
  console.log(`DEMO_BEATS ${JSON.stringify(beats)}`);
  console.log(`DEMO_VIDEO ${videoPath} wall ${duration.toFixed(1)} s`);
  writeFileSync(path.join(EVIDENCE_DIR, 'demo-path.json'), JSON.stringify({ video: 'demo-path.webm', duration_s: duration, beats, ...report }, null, 2));
  expect(duration).toBeLessThan(150);
  expect(fpsReport.median_all).toBeGreaterThanOrEqual(50);
  expect(problems).toEqual([]);
});
