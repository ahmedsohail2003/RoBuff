import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { watchProblems } from './pickRun';

/** web/evidence (git-ignored) unless EVIDENCE_DIR is set; playwright.config.ts sets the same default. */
const EVIDENCE_DIR = path.resolve(process.env.EVIDENCE_DIR ?? path.join(import.meta.dirname, '../evidence'));
const LABEL = 'SIMULATION: both arms are physics simulations. Delay and gravity are modelled. No real robot.';

test('gravity menu, live gravity on every simulation, Bennu escape readout, the space scene and the simulation label', async ({ page }) => {
  const problems: string[] = [];
  watchProblems(page, problems);
  await page.goto('/?input=mouse');
  await page.waitForFunction(() => window.__sim?.ready === true && typeof window.__sim.dropCube === 'function', undefined, { timeout: 90_000 });

  // The label is in the DOM, visible, top left.
  const label = page.getByTestId('simulation-label');
  await expect(label).toHaveText(LABEL);
  await expect(label).toBeVisible();
  const box = (await label.boundingBox())!;
  expect(box.x).toBeLessThan(40);
  expect(box.y).toBeLessThan(40);

  // Menu: five settings, each with its value and source.
  const menuText = await page.locator('#gravity-menu').innerText();
  for (const expected of ['Earth', '9.82', 'Mars', '3.73', 'Moon', '1.62', 'Bennu', '8.3e-5', 'GM 4.8904', 'diameter 484.44', 'spin ignored', 'Orbit', 'real is about 1e-6 g', 'NSSDC']) {
    expect(menuText).toContain(expected);
  }
  const start = await page.evaluate(() => window.__sim!.gravity!());
  expect(start.preset.id).toBe('earth');
  expect(start.sims).toEqual([{ name: 'live', gravity_m_s2: 9.82 }]);

  // Moon from the menu button: the live model holds 1.62, and the drop takes sqrt(2 h / g).
  await page.click('[data-gravity="moon"]');
  await expect(page.locator('[data-gravity="moon"]')).toHaveAttribute('aria-pressed', 'true');
  const moonSims = await page.evaluate(() => window.__sim!.gravity!().sims);
  expect(moonSims).toEqual([{ name: 'live', gravity_m_s2: 1.62 }]);
  const moon = await page.evaluate(() => window.__sim!.dropCube!(0.1, 0.6));
  console.log(`M3_MOON_DROP ${JSON.stringify(moon)}`);
  expect(moon.other_contacts).toEqual([]);
  expect(moon.floor_contact_s).not.toBeNull();
  expect(Math.abs(moon.floor_contact_s! - 0.35)).toBeLessThanOrEqual(0.05);

  await page.click('[data-gravity="earth"]');
  const earth = await page.evaluate(() => window.__sim!.dropCube!(0.1, 0.4));
  console.log(`M3_EARTH_DROP ${JSON.stringify(earth)}`);
  expect(Math.abs(earth.floor_contact_s! - Math.sqrt(0.2 / 9.82))).toBeLessThan(0.01);

  // Bennu: still above 0.09 m after 5 s simulated; the low-gravity note and the escape readout show.
  await page.click('[data-gravity="bennu"]');
  const bennu = await page.evaluate(() => window.__sim!.dropCube!(0.1, 5));
  console.log(`M3_BENNU_DROP ${JSON.stringify(bennu)}`);
  expect(bennu.floor_contact_s).toBeNull();
  expect(bennu.end_height_m).toBeGreaterThan(0.09);
  await expect(page.getByTestId('low-gravity-note')).toBeVisible();
  const escape = page.getByTestId('escape-readout');
  await expect(escape).toContainText('Bennu escape speed about 0.20 m/s');
  await expect(escape).toContainText('cm/s');
  await expect(escape).not.toContainText('gone');
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's5.png') });

  // Throw the cube at 0.30 m/s (above escape speed) and step 6 s: it leaves the 1.5 m sphere.
  await page.evaluate(() => {
    window.__sim!.launchSlotBody!([0, -0.2, 0.224]);
    window.__sim!.advanceSim!(6);
  });
  await expect(escape).toContainText('That rock is gone.');
  const gone = await page.evaluate(() => window.__sim!.escape!());
  console.log(`M3_ESCAPE ${JSON.stringify(gone)}`);
  expect(gone!.gone).toBe(true);
  expect(gone!.distance_m).toBeGreaterThan(1.5);
  expect(gone!.speed_m_s).toBeGreaterThan(0.2);

  // Orbit writes 0.
  await page.click('[data-gravity="orbit"]');
  expect(await page.evaluate(() => window.__sim!.gravity!().sims)).toEqual([{ name: 'live', gravity_m_s2: 0 }]);

  // Scene: dark sky, one draw call for the stars, fps.
  const scene = await page.evaluate(() => window.__sim!.spaceScene!());
  console.log(`M3_SCENE ${JSON.stringify(scene)}`);
  expect(scene.starDrawCalls).toBe(1);
  expect(scene.starCount).toBeGreaterThanOrEqual(5000);
  expect(scene.starCount).toBeLessThanOrEqual(10000);
  expect(scene.background).toBe('#04060c');
  await page.click('[data-gravity="earth"]');
  await page.evaluate(() => window.__sim!.dropCube!(0, 0.1));
  await page.waitForTimeout(3000);
  const fps = await page.evaluate(() => ({ fps: window.__sim!.fps, physicsMs: window.__sim!.lastPhysicsMs, gpu: window.__sim!.renderStats().gpu }));
  console.log(`M3_FPS ${JSON.stringify(fps)}`);
  expect(fps.fps).toBeGreaterThanOrEqual(50);

  // The receipt carries the low-gravity note below 0.1 m/s2, and the friction line re-runs on a gravity change.
  await page.waitForFunction(() => typeof window.__sim?.spawnObject === 'function', undefined, { timeout: 60_000 });
  await page.click('[data-gravity="bennu"]');
  const iron = (await page.evaluate(() => window.__sim!.spawnObject!('solid iron, 60 mm'))) as { stages: { code: string; text: string }[] };
  const lowG = iron.stages.find((s) => s.code === 'LOW_GRAVITY');
  console.log(`M3_LOW_G_STAGE ${JSON.stringify(lowG ?? null)}`);
  expect(lowG?.text).toContain('solver artefacts');
  const recheck = page.getByTestId('friction-recheck');
  await page.click('[data-gravity="moon"]');
  await expect(recheck).toContainText('re-run at Moon');
  await expect(recheck).toContainText('1.62 m/s2');
  const moonRecheck = await recheck.innerText();
  await page.click('[data-gravity="earth"]');
  await expect(recheck).toContainText('9.82 m/s2');
  const earthRecheck = await recheck.innerText();
  console.log(`M3_FRICTION_RECHECK ${JSON.stringify({ moon: moonRecheck, earth: earthRecheck })}`);

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(EVIDENCE_DIR, 's5-gravity.json'), JSON.stringify({ start, moon, earth, bennu, gone, scene, fps, lowG, moonRecheck, earthRecheck }, null, 2));
  expect(problems).toEqual([]);
});
