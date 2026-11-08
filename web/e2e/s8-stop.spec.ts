// M6 stop gesture. Synthetic hand streams (drawn by code, no camera) go through the page's own
// stop-gesture detector: two open hands latch within 0.5 s and every actuator command then holds
// for 2 s with the cube still in the jaws; a 20 s pinch-and-carry replay never stops the arm;
// Space stops in Direct and in Moon (ghost on) mode, and the gesture is not delayed in Moon mode.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { watchProblems } from './pickRun';

const EVIDENCE_DIR = path.resolve(process.env.EVIDENCE_DIR ?? path.join(import.meta.dirname, '../evidence'));

interface Hold {
  samples: number;
  simSpanS: number;
  maxCtrlChange: number;
  cubeZFirst: number | null;
  cubeZLast: number | null;
  ghostGripperMoveMm: number | null;
  stoppedThroughout: boolean;
}

/** Samples getCtrl every frame for `seconds` of simulated time; compares each to `reference`. */
async function holdFor(page: Page, seconds: number, reference: number[] | null): Promise<Hold> {
  return page.evaluate(
    ({ seconds, reference }) =>
      new Promise<Hold>((resolve) => {
        const sim = window.__sim!;
        const ref = reference ?? sim.getCtrl();
        const t0 = sim.simTime;
        const ghost0 = sim.delayState?.().ghostGripper ?? null;
        const cubeZFirst = sim.getBodyPos('cube')?.[2] ?? null;
        let samples = 0;
        let maxCtrlChange = 0;
        let stoppedThroughout = true;
        const tick = () => {
          const ctrl = sim.getCtrl();
          samples++;
          for (let i = 0; i < ctrl.length; i++) maxCtrlChange = Math.max(maxCtrlChange, Math.abs(ctrl[i]! - ref[i]!));
          if (!sim.stopped) stoppedThroughout = false;
          if (sim.simTime - t0 >= seconds) {
            const ghost1 = sim.delayState?.().ghostGripper ?? null;
            resolve({
              samples,
              simSpanS: sim.simTime - t0,
              maxCtrlChange,
              cubeZFirst,
              cubeZLast: sim.getBodyPos('cube')?.[2] ?? null,
              ghostGripperMoveMm: ghost0 && ghost1 ? 1000 * Math.hypot(ghost1[0] - ghost0[0], ghost1[1] - ghost0[1], ghost1[2] - ghost0[2]) : null,
              stoppedThroughout,
            });
          } else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { seconds, reference },
  );
}

async function waitSimTime(page: Page, t: number): Promise<void> {
  await page.waitForFunction((until) => window.__sim!.simTime >= until, t, { timeout: 60_000 });
}

async function resume(page: Page): Promise<void> {
  await page.locator('#stop-clear').click();
  await page.waitForFunction(() => window.__sim!.stopped === false);
}

/** Presses Space and reports the stop, then checks the commands hold for `seconds` simulated. */
async function spaceStop(page: Page, seconds: number) {
  const before = await page.evaluate(() => ({ simTime: window.__sim!.simTime, stopped: window.__sim!.stopped }));
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__sim!.stopped === true, undefined, { timeout: 5_000 });
  const at = await page.evaluate(() => ({ ctrl: window.__sim!.getCtrl(), state: window.__sim!.stopGesture!(), simTime: window.__sim!.simTime }));
  const hold = await holdFor(page, seconds, at.ctrl);
  return { before, why: at.state.stopWhy, stopSimS: at.state.stopSince, latchAfterPressS: (at.state.stopSince ?? NaN) - before.simTime, hold };
}

test('stop gesture: two open hands latch within 0.5 s and hold, pinch-and-carry never stops, Space stops in Direct and Moon', async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const problems: string[] = [];
  watchProblems(page, problems);

  await page.goto('/?input=synthetic&hands=2&speed=3');
  await page.waitForFunction(
    () => window.__sim?.ready === true && typeof window.__sim.replayStopGesture === 'function' && typeof window.__sim.setDelayMode === 'function',
    undefined,
    { timeout: 90_000 },
  );
  const initial = await page.evaluate(() => window.__sim!.stopGesture!());
  expect(initial.enabled).toBe(true);
  expect(initial.mode).toBe('two-hands');
  expect(initial.holdS).toBe(0.4);
  await expect(page.getByTestId('stop-gesture')).toContainText('both hands open');

  // 1. A 20 s pinch-and-carry replay (the S2 pick's hand, repeated) while the synthetic hand
  // runs the same pick on the arm. It must never stop the arm.
  await page.evaluate(() => window.__sim!.reset());
  const carry = await page.evaluate(() => window.__sim!.replayStopGesture!('pinch-carry', 20));
  const afterCarry = await page.evaluate(() => ({ stopped: window.__sim!.stopped, input: window.__sim!.input(), cubeZ: window.__sim!.getBodyPos('cube')?.[2] ?? null }));
  expect(carry.frames).toBeGreaterThanOrEqual(600);
  expect(carry.fires).toBe(0);
  expect(carry.posedFrames).toBe(0);
  expect(carry.stoppedAtEnd).toBe(false);
  expect(afterCarry.stopped).toBe(false);

  // 2. Restart the pick at speed 1; at the hold phase (cube lifted, jaw closed) show two open hands.
  await page.evaluate(() => {
    window.__sim!.speed = 1;
    window.__sim!.reset();
  });
  const pickStart = await page.evaluate(() => window.__sim!.simTime);
  await page.waitForFunction(() => window.__sim!.input().phase === 'hold', undefined, { timeout: 60_000 });
  const beforeGesture = await page.evaluate(() => ({ phase: window.__sim!.input().phase, cubeZ: window.__sim!.getBodyPos('cube')?.[2] ?? null, simTime: window.__sim!.simTime }));
  const gesture = await page.evaluate(() => window.__sim!.replayStopGesture!('two-open-hands', 1.0));
  expect(gesture.fires).toBe(1);
  expect(gesture.fireAtS).not.toBeNull();
  expect(gesture.latchAfterS).not.toBeNull();
  expect(gesture.latchAfterS!).toBeLessThan(0.5);
  expect(gesture.stopWhy).toBe('stop gesture');
  const gestureHold = await holdFor(page, 2.0, gesture.ctrlAtLatch);
  const banner = await page.evaluate(() => window.__sim!.screenStates!().stopBanner);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's8-stop-gesture.png') });
  expect(gestureHold.stoppedThroughout).toBe(true);
  expect(gestureHold.simSpanS).toBeGreaterThanOrEqual(2.0);
  expect(gestureHold.maxCtrlChange).toBe(0);
  expect(banner).toContain('stop gesture');
  expect(banner).toContain('synthetic replay');
  // Nothing dropped: the cube was lifted before the gesture and is still up after 2 s stopped.
  expect(beforeGesture.cubeZ!).toBeGreaterThan(0.05);
  expect(gestureHold.cubeZLast!).toBeGreaterThan(0.05);

  // 3. Space in Direct mode (the synthetic pick restarted, arm moving).
  await resume(page);
  await page.evaluate(() => window.__sim!.reset());
  const directStart = await page.evaluate(() => window.__sim!.simTime);
  await waitSimTime(page, directStart + 1.5);
  const direct = await spaceStop(page, 1.5);
  expect(direct.why).toBe('space key');
  expect(direct.hold.maxCtrlChange).toBe(0);
  expect(direct.hold.stoppedThroughout).toBe(true);

  // 4. Moon mode with the ghost: Space, then the gesture (not delayed by the 1.28 s line).
  await resume(page);
  const moonSwitch = await page.evaluate(() => window.__sim!.setDelayMode!('moon_ghost_on'));
  expect(moonSwitch.mode).toBe('moon_ghost_on');
  const moonStart = await page.evaluate(() => window.__sim!.simTime);
  await waitSimTime(page, moonStart + 3.0);
  const moon = await spaceStop(page, 1.5);
  const moonState = await page.evaluate(() => window.__sim!.delayState!());
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's8-stop-moon.png') });
  expect(moon.why).toBe('space key');
  expect(moon.hold.maxCtrlChange).toBe(0);
  expect(moon.hold.stoppedThroughout).toBe(true);
  expect(moon.hold.ghostGripperMoveMm).not.toBeNull();
  await resume(page);
  await waitSimTime(page, moonStart + 6.0);
  const moonGesture = await page.evaluate(() => window.__sim!.replayStopGesture!('two-open-hands', 1.0));
  const moonGestureHold = await holdFor(page, 1.0, moonGesture.ctrlAtLatch);
  expect(moonGesture.fires).toBe(1);
  expect(moonGesture.latchAfterS!).toBeLessThan(0.5);
  expect(moonGestureHold.maxCtrlChange).toBe(0);

  // 5. Back to Direct, cleared, and one open hand alone does nothing.
  await resume(page);
  await page.evaluate(() => window.__sim!.setDelayMode!('direct'));
  const oneHand = await page.evaluate(() => window.__sim!.replayStopGesture!('one-open-hand', 3.0));
  expect(oneHand.fires).toBe(0);
  expect(oneHand.stoppedAtEnd).toBe(false);

  // 6. Measurement only (not asserted): painted synthetic hands through the real HandLandmarker,
  // to see what the open-hand thresholds make of tracker landmarks. A painted hand is not a real hand.
  const pictures = [];
  for (const kind of ['two-open-hands', 'open-and-pinched', 'one-open-hand', 'one-pinched-hand'] as const) {
    pictures.push(await page.evaluate((k) => window.__sim!.stopGestureOnPicture!(k), kind));
  }

  const report = {
    note: 'Synthetic hand streams drawn by code (no camera); simulated arm. Times are simulated seconds.',
    initial,
    pinchCarry: carry,
    afterCarry: { stopped: afterCarry.stopped, phase: (afterCarry.input as Record<string, unknown>).phase, cubeZ: afterCarry.cubeZ },
    pickStartSimS: pickStart,
    beforeGesture,
    gesture,
    gestureHold,
    banner,
    direct,
    moonSwitch,
    moon,
    moonError: moonState.error,
    moonGesture,
    moonGestureHold,
    oneHand,
    pictures,
    finalLine: await page.getByTestId('stop-gesture').textContent(),
    problems,
  };
  console.log(`S8_STOP ${JSON.stringify(report)}`);
  writeFileSync(path.join(EVIDENCE_DIR, 's8-stop.json'), JSON.stringify(report, null, 2));
  expect(problems).toEqual([]);
});
