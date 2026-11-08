// Voice moves the arm, offline: typed lines in the voice panel go through the grammar and the
// voice source in the operator's seat. Every check reads the real simulation state: the gripper
// site, the jaw, the test cube's centre of mass and its jaw contacts, and the Moon delay rig.
// Run with no key server (KEY_SERVER_PORT=8799), so the page is offline by itself.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';
import { watchProblems } from './pickRun';

const EVIDENCE_DIR = path.resolve(process.env.EVIDENCE_DIR ?? path.join(import.meta.dirname, '../evidence'));
type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mm = (m: number): number => Math.round(m * 10000) / 10;

async function site(page: Page): Promise<V3> {
  return (await page.evaluate(() => window.__sim!.getSitePos('gripper'))) as V3;
}

async function waitSim(page: Page, seconds: number): Promise<void> {
  const until = (await page.evaluate(() => window.__sim!.simTime)) + seconds;
  await page.waitForFunction((t) => window.__sim!.simTime >= t, until, { timeout: 60_000 });
}

/** Types a line and waits until the console has finished it (moves are awaited to the end). */
async function typed(page: Page, text: string, timeout = 60_000): Promise<{ said: string | null; action: string }> {
  const before = await page.evaluate(() => window.__sim!.voiceResults!().length);
  await page.getByTestId('voice-text').fill(text);
  await page.getByTestId('voice-text').press('Enter');
  await page.waitForFunction(
    ([t, n]) => window.__sim!.voiceResults!().slice(n as number).some((r) => r.text === t && r.said !== null),
    [text, before] as const,
    { timeout },
  );
  return page.evaluate(([t, n]) => {
    const r = window.__sim!.voiceResults!().slice(n as number).find((x) => x.text === t)!;
    return { said: r.said, action: r.action.type };
  }, [text, before] as const);
}

test('voice moves the arm: left 5 cm, up a bit, grip, pick, put down, stop, Moon delay, hand back', async ({ page }) => {
  test.setTimeout(240_000);
  const problems: string[] = [];
  watchProblems(page, problems);
  const report: Record<string, unknown> = {};
  await page.goto('/?input=mouse&mute=1&speed=2');
  await page.waitForFunction(() => window.__sim?.ready === true && typeof window.__sim.voiceCommand === 'function' && typeof window.__sim.voiceMotion === 'function' && typeof window.__sim.setDelayMode === 'function', undefined, { timeout: 90_000 });
  await expect(page.getByTestId('brain-badge')).toHaveText('object brain: offline mock (no key)');
  await waitSim(page, 1);

  // 1. "move left 5 centimetres": 45-55 mm along screen left.
  const screen = await page.evaluate(() => window.__sim!.screen());
  const left: V3 = [-screen.right[0], -screen.right[1], -screen.right[2]];
  const s0 = await site(page);
  const moved = await typed(page, 'move left 5 centimetres');
  await waitSim(page, 0.5);
  const s1 = await site(page);
  const along = dot(sub(s1, s0), left);
  const across = Math.hypot(...sub(sub(s1, s0), left.map((v) => v * along) as V3));
  report.left = { azimuth: screen.azimuth, along_mm: mm(along), across_mm: mm(across), said: moved.said, voice: await page.evaluate(() => window.__sim!.voiceMotion()) };
  expect(moved.action).toBe('move');
  expect(along * 1000).toBeGreaterThanOrEqual(45);
  expect(along * 1000).toBeLessThanOrEqual(55);
  await expect(page.getByTestId('hand-back')).toBeVisible();

  // 2. "go up a bit": 15-25 mm up.
  await typed(page, 'go up a bit');
  await waitSim(page, 0.5);
  const s2 = await site(page);
  report.up = { dz_mm: mm(s2[2] - s1[2]) };
  expect((s2[2] - s1[2]) * 1000).toBeGreaterThanOrEqual(15);
  expect((s2[2] - s1[2]) * 1000).toBeLessThanOrEqual(25);

  // 3. "close the gripper": the jaw closes (commanded grip 1, a gap of a few mm).
  const gapOpen = await page.evaluate(() => window.__sim!.gripperOpening());
  await typed(page, 'close the gripper');
  await waitSim(page, 0.4);
  const closed = await page.evaluate(() => ({ gap: window.__sim!.gripperOpening(), grip: window.__sim!.controller().grip, jaw: window.__sim!.getCtrl()[5] }));
  report.close = { gap_before_mm: mm(gapOpen), gap_after_mm: mm(closed.gap), grip: closed.grip, jaw_ctrl: closed.jaw };
  expect(closed.grip).toBe(1);
  expect(closed.gap).toBeLessThan(0.008);

  // 4. "pick it up": the test cube rises at least 40 mm with both jaws on it.
  const before = (await page.evaluate(() => window.__sim!.voiceObject!()))!;
  const picked = await typed(page, 'pick it up', 90_000);
  const held = (await page.evaluate(() => window.__sim!.voiceObject!()))!;
  report.pick = { said: picked.said, rise_mm: mm(held.com[2] - before.com[2]), jaws: held.jaws, holding: held.holding };
  expect(held.com[2] - before.com[2]).toBeGreaterThanOrEqual(0.04);
  expect(held.jaws).toEqual(['Fixed_Jaw', 'Moving_Jaw']);
  expect(held.holding).toBe(true);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 'voice-motion-holding.png') });

  // 5. "put it down": on the floor, jaw clear.
  const placed = await typed(page, 'put it down', 90_000);
  await waitSim(page, 0.5);
  const down = (await page.evaluate(() => window.__sim!.voiceObject!()))!;
  report.place = { said: placed.said, lowest_mm: mm(down.lowest), com_mm: mm(down.com[2]), jaws: down.jaws };
  expect(down.lowest).toBeLessThan(0.005);
  expect(down.jaws).toEqual([]);
  expect(down.holding).toBe(false);

  // 6. "stop" during a move, typed into the panel: the voice queue is cleared at once, the arm
  // brakes (ctrl is set once, at the latch, to the measured joints) and then no command reaches it.
  await page.getByTestId('voice-text').fill('move right 20 cm');
  await page.getByTestId('voice-text').press('Enter');
  await page.waitForFunction(() => window.__sim!.voiceMotion()?.state === 'moving', undefined, { timeout: 10_000 });
  await waitSim(page, 0.8);
  // Submit "stop" and read the site in the same task, so the window starts exactly at the latch.
  const atStop = await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="voice-text"]')!;
    input.value = 'stop';
    input.form!.requestSubmit();
    return { stopped: window.__sim!.stopped, site: window.__sim!.getSitePos('gripper') as V3, t: window.__sim!.simTime, ctrl: window.__sim!.getCtrl(), goal: window.__sim!.voiceMotion()!.goal };
  });
  expect(atStop.stopped).toBe(true);
  await waitSim(page, 0.5);
  const afterStop = await page.evaluate(() => ({ site: window.__sim!.getSitePos('gripper') as V3, t: window.__sim!.simTime, ctrl: window.__sim!.getCtrl(), voice: window.__sim!.voiceMotion() }));
  const drift = Math.hypot(...sub(afterStop.site, atStop.site));
  report.stop = { drift_mm: mm(drift), window_s: afterStop.t - atStop.t, ctrl_same: JSON.stringify(atStop.ctrl) === JSON.stringify(afterStop.ctrl), goal_same: JSON.stringify(atStop.goal) === JSON.stringify(afterStop.voice!.goal), voice: afterStop.voice };
  console.log(`VOICE_STOP_E2E ${JSON.stringify(report.stop)}`);
  expect(afterStop.ctrl).toEqual(atStop.ctrl);
  expect(afterStop.voice!.goal).toEqual(atStop.goal);
  expect(afterStop.voice!.busy).toBe(false);
  // The plan's criterion: under 2 mm over the next 0.5 s.
  expect(drift * 1000).toBeLessThan(2);
  await page.click('#stop-clear');
  await page.waitForFunction(() => window.__sim!.stopped === false);

  // 7. Moon, ghost on: "move up 5 centimetres" moves the ghost at once and the true arm 1.2 s or more later.
  await page.evaluate(() => window.__sim!.setDelayMode!('moon_ghost_on'));
  await waitSim(page, 1.5);
  const z0 = await page.evaluate(() => ({ truth: window.__sim!.delayState!().truthGripper![2], ghost: window.__sim!.delayState!().ghostGripper![2], t: window.__sim!.simTime }));
  await page.evaluate(() => {
    const w = window as unknown as { __moon: { t: number; truth: number; ghost: number }[]; __moonStop: boolean };
    w.__moon = [];
    w.__moonStop = false;
    const tick = () => {
      const d = window.__sim!.delayState!();
      w.__moon.push({ t: window.__sim!.simTime, truth: d.truthGripper![2], ghost: d.ghostGripper![2] });
      if (!w.__moonStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const sentAt = await page.evaluate(() => window.__sim!.simTime);
  await typed(page, 'move up 5 centimetres');
  await waitSim(page, 2.5);
  const samples = await page.evaluate(() => {
    const w = window as unknown as { __moon: { t: number; truth: number; ghost: number }[]; __moonStop: boolean };
    w.__moonStop = true;
    return w.__moon;
  });
  const ghostAt = samples.find((s) => s.ghost > z0.ghost + 0.002)?.t ?? null;
  const truthAt = samples.find((s) => s.truth > z0.truth + 0.002)?.t ?? null;
  const last = samples[samples.length - 1]!;
  report.moon = { sent_s: sentAt, ghost_moved_2mm_s: ghostAt, truth_moved_2mm_s: truthAt, ghost_rise_mm: mm(last.ghost - z0.ghost), truth_rise_mm: mm(last.truth - z0.truth) };
  expect(ghostAt).not.toBeNull();
  expect(truthAt).not.toBeNull();
  expect(ghostAt! - sentAt).toBeLessThan(0.6);
  expect(truthAt! - sentAt).toBeGreaterThanOrEqual(1.2);
  expect((last.truth - z0.truth) * 1000).toBeGreaterThan(40);

  // 8. "hand control" gives the arm back to the mouse.
  const box = (await page.locator('#viewport canvas').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2 + 5, box.y + box.height / 2 + 5);
  await typed(page, 'hand control');
  await page.waitForFunction(() => window.__sim!.voiceMotion() === null, undefined, { timeout: 30_000 });
  const input = await page.evaluate(() => window.__sim!.input());
  report.handBack = { input: input.kind };
  expect(input.kind).toBe('mouse');
  await expect(page.getByTestId('hand-back')).toBeHidden();

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(EVIDENCE_DIR, 'voice-motion.json'), JSON.stringify(report, null, 2));
  console.log(`VOICE_MOTION_E2E ${JSON.stringify(report)}`);
  expect(problems).toEqual([]);
});

test('a typed sentence the grammar does not know goes to the chat brain, and its move action moves the arm', async ({ page }) => {
  test.setTimeout(120_000);
  const fulfil = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  const chats: string[] = [];
  await page.route('**/api/health', (route) => fulfil(route, { ok: true, gemini: 'configured', elevenlabs: 'missing' }));
  await page.route('**/api/chat', (route) => {
    chats.push(String((route.request().postDataJSON() as { text: string }).text));
    return fulfil(route, { source: 'gemini', reply: 'Shifting it left, in simulation.', actions: [{ type: 'move', value: 'left 3 cm' }], latency_ms: 2 });
  });
  await page.goto('/?input=mouse&mute=1&speed=2');
  await page.waitForFunction(() => window.__sim?.ready === true && typeof window.__sim.voiceMotion === 'function' && window.__sim.voiceBadges!().brain.includes('live'), undefined, { timeout: 90_000 });
  await waitSim(page, 1);
  const screen = await page.evaluate(() => window.__sim!.screen());
  const s0 = await site(page);
  await page.getByTestId('voice-text').fill('shuffle the claw over toward my left side');
  await page.getByTestId('voice-text').press('Enter');
  await page.waitForFunction(() => window.__sim!.voiceResults!().some((r) => r.action.type === 'move' && r.by === 'gemini' && r.said !== null), undefined, { timeout: 30_000 });
  await waitSim(page, 0.5);
  const along = -dot(sub(await site(page), s0), screen.right as V3);
  console.log(`VOICE_CHAT_TYPED chats ${chats.length} along_left_mm ${mm(along)}`);
  expect(chats).toEqual(['shuffle the claw over toward my left side']);
  expect(along * 1000).toBeGreaterThanOrEqual(25);
  expect(along * 1000).toBeLessThanOrEqual(35);
});

// The verifier found "I am already holding it" after a reset: the drop watch's 50 ms gate never
// opened once the sim clock ran from 0 again, and the voice source kept its "picking it up" label.
test('after a reset or a respawn, "pick it up" never answers "already holding"', async ({ page }) => {
  test.setTimeout(300_000);
  const problems: string[] = [];
  watchProblems(page, problems);
  await page.goto('/?input=mouse&mute=1&speed=2');
  await page.waitForFunction(() => window.__sim?.ready === true && typeof window.__sim.voiceCommand === 'function' && typeof window.__sim.spawnObject === 'function', undefined, { timeout: 90_000 });
  await waitSim(page, 1);
  const first = await typed(page, 'pick it up', 90_000);
  expect((await page.evaluate(() => window.__sim!.voiceObject!()))!.holding, `first pick: ${first.said}`).toBe(true);

  // Reset: the hold ends, the label goes, and a new pick runs instead of a refusal.
  await page.evaluate(() => window.__sim!.reset());
  await waitSim(page, 0.5);
  const afterReset = await page.evaluate(() => ({ holding: window.__sim!.voiceObject!()!.holding, voice: window.__sim!.voiceMotion() as { label?: string } | null }));
  expect(afterReset.holding).toBe(false);
  expect(afterReset.voice?.label ?? '').not.toBe('picking it up');
  const again = await typed(page, 'pick it up', 90_000);
  expect(again.said ?? '').not.toMatch(/already holding/i);
  expect((await page.evaluate(() => window.__sim!.voiceObject!()))!.holding, `pick after reset: ${again.said}`).toBe(true);

  // Respawn: a new object in the slot ends the hold too.
  const spawned = (await page.evaluate(() => window.__sim!.spawnObject!('a tennis ball'))) as { spawned?: boolean };
  expect(spawned.spawned).toBe(true);
  await waitSim(page, 0.5);
  const afterSpawn = await page.evaluate(() => ({ holding: window.__sim!.voiceObject!()?.holding ?? false, voice: window.__sim!.voiceMotion() as { label?: string } | null }));
  expect(afterSpawn.holding).toBe(false);
  expect(afterSpawn.voice?.label ?? '').not.toBe('picking it up');
  const third = await typed(page, 'pick it up', 90_000);
  expect(third.said ?? '').not.toMatch(/already holding/i);
  console.log(`VOICE_HOLD_RESET ${JSON.stringify({ first: first.said, again: again.said, third: third.said, afterReset, afterSpawn })}`);
  expect(problems).toEqual([]);
});
