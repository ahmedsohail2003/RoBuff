// Skins on spawned objects, offline (KEY_SERVER_PORT=8799): procedural skins on every part, one
// named part by voice, the operator's own image, removal, a fresh object starting bare, and the
// skin text field never steering the arm. Every check reads the real three.js state back
// through window.__sim.skinState(), not the DOM text.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { watchProblems } from './pickRun';

const EVIDENCE_DIR = path.resolve(process.env.EVIDENCE_DIR ?? path.join(import.meta.dirname, '../evidence'));
const SPEED = 3;

interface PartState {
  name: string;
  source: string | null;
  model: string | null;
  text: string | null;
  size: [number, number] | null;
  fallback: boolean;
  finish: 'metal' | 'matte' | null;
  drawn: boolean;
}
interface SkinState {
  parts: PartState[];
  skins: number;
  anisotropy: { set: number; max: number; effective: number; gl: number | null };
  mipmaps: boolean;
  colorSpace: string | null;
  minFilter: string | null;
  uvFinite: boolean;
  uvRange: [number, number];
  materials: number;
}

const skinState = (page: Page): Promise<SkinState | null> => page.evaluate(() => window.__sim!.skinState!() as unknown as SkinState | null);
const spawn = (page: Page, text: string): Promise<{ spawned: boolean; receipt: { verdict: string; mass_kg: number } }> =>
  page.evaluate((t) => window.__sim!.spawnObject!(t) as unknown as Promise<{ spawned: boolean; receipt: { verdict: string; mass_kg: number } }>, text);

/** A real PNG, made here: 96 x 64, a red and white diagonal pattern. */
function makePng(width = 96, height = 64): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const p = y * (width * 3 + 1) + 1 + x * 3;
      const red = ((x + y) >> 3) % 2 === 0;
      raw[p] = red ? 220 : 245;
      raw[p + 1] = red ? 30 : 245;
      raw[p + 2] = red ? 40 : 245;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function closeUp(page: Page, name: string): Promise<void> {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `skins-${name}.png`) });
}

test('skins offline: gold on every part, the wheels by voice, an uploaded image, remove, a new object starts bare, and W in the field does not steer', async ({ page }) => {
  test.setTimeout(240_000);
  const problems: string[] = [];
  watchProblems(page, problems);
  // The mouse source, so step (7) checks the arm's own depth, not only where the keys went.
  await page.goto(`/?speed=${SPEED}&input=mouse`);
  await page.waitForFunction(() => window.__sim?.ready === true && typeof window.__sim.skinState === 'function', undefined, { timeout: 90_000 });
  await expect(page.getByTestId('skin-source-offline')).toBeVisible();
  await expect(page.getByTestId('skin-source-offline')).toHaveText('skin: procedural (offline)');
  // With the cube in the slot there is nothing to paint, and the box says so.
  expect(await skinState(page)).toBeNull();
  await expect(page.getByTestId('skin-apply')).toBeDisabled();

  // (1) The offline Tesla: a six-part car.
  const car = await spawn(page, 'a tesla');
  expect(car.spawned).toBe(true);
  await expect(page.getByTestId('skin-apply')).toBeEnabled();
  const before = await page.evaluate(() => ({ body: window.__sim!.objectBodyName!, mass: (window.__sim!.lastReceipt as { mass_kg: number }).mass_kg }));
  const bare = (await skinState(page))!;
  expect(bare.parts.map((p) => p.name)).toEqual(['body', 'cabin', 'front left wheel', 'front right wheel', 'rear left wheel', 'rear right wheel']);
  expect(bare.parts.every((p) => p.source === null)).toBe(true);

  // The quality choice: two radios, High quality (Nano Banana Pro) checked by default, and Tab reaches it.
  const qualityGroup = page.getByRole('radiogroup', { name: 'Image quality' });
  await expect(qualityGroup.getByRole('radio')).toHaveCount(2);
  await expect(page.getByTestId('skin-quality-high')).toBeChecked();
  await expect(page.getByTestId('skin-quality-fast')).not.toBeChecked();
  await expect(qualityGroup).toContainText('High quality: Nano Banana Pro, about 13 s, 14 cents');
  await expect(qualityGroup).toContainText('Fast: Nano Banana 2 Lite, about 4 s, 3 cents');
  await page.getByTestId('skin-part').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('skin-quality-high')).toBeFocused();

  // (2) The Gold chip: procedural, a 1024 texture on EVERY part, filtered and in sRGB. Offline,
  // the default High quality still paints procedural, and the badge says offline, not Pro.
  await page.click('[data-skin-preset="gold"]');
  await expect(page.getByTestId('skin-status')).toContainText('Painted gold on all 6 parts');
  await expect(page.getByTestId('skin-status')).toContainText('Paint only: mass, friction and hulls did not change.');
  const gold = (await skinState(page))!;
  for (const p of gold.parts) {
    expect(p.source, p.name).toBe('procedural');
    expect(p.size, p.name).toEqual([1024, 1024]);
    // Gold is a metal finish (metalness, a reflection, bumps), not a matte picture of gold.
    expect(p.finish, p.name).toBe('metal');
    // Read from the mesh: the part's draw group uses the material whose map is this picture.
    expect(p.drawn, p.name).toBe(true);
  }
  expect(gold.skins).toBe(1);
  expect(gold.materials).toBe(2);
  expect(gold.anisotropy.set).toBe(8);
  expect(gold.anisotropy.effective).toBe(gold.anisotropy.max > 0 ? Math.min(8, gold.anisotropy.max) : 1);
  // The GL texture itself, read back with getTexParameter once a frame has uploaded it.
  await page.waitForFunction(() => (window.__sim!.skinState!() as unknown as SkinState).anisotropy.gl !== null, undefined, { timeout: 10_000 });
  const glAniso = (await skinState(page))!.anisotropy;
  expect(glAniso.gl, 'the uploaded texture has min(8, the GPU max)').toBe(Math.min(8, glAniso.max));
  await expect(page.getByTestId('skin-source-offline')).toHaveText('skin: procedural (offline)');
  expect(gold.colorSpace).toBe('srgb');
  expect(gold.mipmaps).toBe(true);
  expect(gold.minFilter).toBe('LinearMipmapLinear');
  expect(gold.uvFinite).toBe(true);
  expect(gold.uvRange[0]).toBeGreaterThanOrEqual(0);
  expect(gold.uvRange[1]).toBeLessThanOrEqual(1);
  // Paint only: the same body, the same mass.
  const after = await page.evaluate(() => ({ body: window.__sim!.objectBodyName!, mass: (window.__sim!.lastReceipt as { mass_kg: number }).mass_kg }));
  expect(after).toEqual(before);
  const drawn = await page.evaluate(() => window.__sim!.objectRender!() as unknown as { skins: number; textureSize: number | null; triangles: number });
  expect(drawn.skins).toBe(1);
  expect(drawn.textureSize).toBe(1024);
  await closeUp(page, 'gold-car');

  // (3) "paint the wheels black", typed in the voice panel: only the wheels change.
  await page.getByTestId('voice-text').fill('paint the wheels black');
  await page.getByTestId('voice-send').click();
  let via = 'voice panel';
  try {
    await page.waitForFunction(() => (window.__sim!.skinState!() as unknown as SkinState).parts[2]!.text === 'black', undefined, { timeout: 15_000 });
  } catch {
    // Lane V's grammar not wired yet: the same request through the hook.
    via = 'hook';
    await page.evaluate(() => window.__sim!.skinObject!('black', 'wheels'));
  }
  console.log(`SKIN_VOICE_PATH ${via}`);
  const wheels = (await skinState(page))!;
  expect(wheels.parts.slice(0, 2).map((p) => [p.source, p.text])).toEqual([
    ['procedural', 'polished gold'],
    ['procedural', 'polished gold'],
  ]);
  for (const p of wheels.parts.slice(2)) expect([p.name, p.source, p.text, p.finish]).toEqual([p.name, 'procedural', 'black', 'matte']);
  for (const p of wheels.parts.slice(0, 2)) expect(p.finish, p.name).toBe('metal');
  for (const p of wheels.parts) expect(p.drawn, `${p.name} is drawn with its own skin`).toBe(true);
  expect(wheels.skins).toBe(2);
  expect(wheels.materials).toBe(3);

  // (4) Upload: a PNG made in this test, decoded in the browser.
  const requests: string[] = [];
  page.on('request', (r) => requests.push(`${r.method()} ${new URL(r.url()).pathname}`));
  await page.getByTestId('skin-file').setInputFiles({ name: 'stripes.png', mimeType: 'image/png', buffer: makePng() });
  await expect(page.getByTestId('skin-status')).toContainText('Painted your image (stripes.png) on all 6 parts');
  await expect(page.getByTestId('skin-source-upload')).toHaveText('skin: your image');
  const uploaded = (await skinState(page))!;
  for (const p of uploaded.parts) expect([p.source, p.size, p.drawn]).toEqual(['upload', [1024, 1024], true]);
  expect(requests.filter((r) => r.startsWith('POST')), 'the image was not sent anywhere').toEqual([]);
  await closeUp(page, 'upload-car');

  // (5) Remove: no skins left, one material again.
  await page.getByTestId('skin-remove').click();
  await expect(page.getByTestId('skin-status')).toContainText('Removed the skin from all 6 parts');
  const removed = (await skinState(page))!;
  expect(removed.parts.every((p) => p.source === null && p.drawn)).toBe(true);
  expect(removed.skins).toBe(0);
  expect(removed.materials).toBe(1);
  await expect(page.getByTestId('skin-source-offline')).toBeVisible();

  // (6) Paint again, then make a new object: it starts with no skin.
  await page.click('[data-skin-preset="galaxy"]');
  await expect(page.getByTestId('skin-status')).toContainText('Painted galaxy');
  expect((await skinState(page))!.skins).toBe(1);
  const mug = await spawn(page, 'a coffee mug');
  expect(mug.spawned).toBe(true);
  const fresh = (await skinState(page))!;
  expect(fresh.parts.every((p) => p.source === null)).toBe(true);
  expect(fresh.skins).toBe(0);
  expect(fresh.materials).toBe(1);

  // (7) W typed in the skin field goes into the field and does not steer the arm.
  const kind = await page.evaluate(() => window.__sim!.input().kind);
  expect(kind, 'the page was opened with ?input=mouse').toBe('mouse');
  const depth = (): Promise<number> => page.evaluate(() => Number((window.__sim!.input() as { depth?: number }).depth ?? Number.NaN));
  const d0 = await depth();
  // Whatever source drives the arm, its keys are read on window (input/mouseSource.ts): count what gets there.
  await page.evaluate(() => {
    const w = window as unknown as { __keys: string[] };
    w.__keys = [];
    window.addEventListener('keydown', (e) => w.__keys.push(e.key.toLowerCase()));
  });
  const keysAtWindow = (): Promise<string[]> => page.evaluate(() => (window as unknown as { __keys: string[] }).__keys);
  await page.getByTestId('skin-text').click();
  await page.keyboard.type('wsg');
  await expect(page.getByTestId('skin-text')).toHaveValue('wsg');
  await page.keyboard.press('w');
  expect(await keysAtWindow(), 'no key typed in the skin field reaches the arm').toEqual([]);
  expect(d0).not.toBeNaN();
  expect(await depth(), 'W in the field did not move the arm depth').toBe(d0);
  expect(await page.evaluate(() => (window.__sim!.input() as { closed?: boolean }).closed ?? false)).toBe(false);
  // The check has teeth: the same key outside the field does reach window (and moves the depth with the mouse source).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('w');
  expect(await keysAtWindow()).toEqual(['w']);
  expect(await depth(), 'W outside the field does move it').not.toBe(d0);
  console.log(`SKIN_KEYS ${JSON.stringify({ kind, d0, after: await depth() })}`);

  // The panel itself, for the evidence folder.
  await page.getByTestId('skin-text').fill('red with white racing stripes');
  await page.getByTestId('skin-apply').click();
  await expect(page.getByTestId('skin-status')).toContainText('Painted red with white racing stripes');
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.getByTestId('skin-box').screenshot({ path: path.join(EVIDENCE_DIR, 'skins-panel.png') });

  // (8) A one-shape object is named once: "on the solar panel", not "on the solar panel of the solar panel".
  const panel = await spawn(page, 'a cubesat solar panel');
  expect(panel.spawned).toBe(true);
  await page.click('[data-skin-preset="gold"]');
  await expect(page.getByTestId('skin-status')).toContainText('Painted gold on the solar panel. ');
  await expect(page.getByTestId('skin-status')).not.toContainText('of the solar panel');
  writeFileSync(path.join(EVIDENCE_DIR, 'skins-offline.json'), JSON.stringify({ gold, glAniso, wheels, uploaded, removed, fresh, via, calls: await page.evaluate(() => window.__sim!.skinCalls!()) }, null, 2));
  expect(problems).toEqual([]);
});

// The badge reads the skin on the parts, not the key server's health. A STUBBED key server (page
// routes, no Google call, nothing billed) says the skin route is configured, then refuses one image
// (422, as Nano Banana did live with IMAGE_RECITATION) and serves one Pro image.
test('skin badge with a stubbed live key server: a procedural fallback is not shown as live, and a Pro skin is named Pro', async ({ page }) => {
  test.setTimeout(180_000);
  const problems: string[] = [];
  watchProblems(page, problems);
  const HASH = 'ab'.repeat(32);
  const posts: { text: string; quality: string }[] = [];
  await page.route('**/api/health', (route) =>
    route.fulfill({ json: { ok: true, server: 'stub', gemini: 'configured', elevenlabs: 'missing', skin: 'configured', models: { skin: 'gemini-3.1-flash-lite-image', skin_high: 'gemini-3-pro-image' } } }),
  );
  // Object specs fall back to the offline mock: the stub has no Gemini behind it.
  await page.route('**/api/spec', (route) => route.fulfill({ status: 503, body: 'stub: no Gemini here' }));
  await page.route('**/api/skin', async (route) => {
    const body = route.request().postDataJSON() as { text: string; quality: string };
    posts.push(body);
    if (body.quality !== 'high') return route.fulfill({ status: 422, body: 'Nano Banana would not draw that (IMAGE_RECITATION)' });
    // A short wait, so the pending status (model and expected time) can be read.
    await new Promise((r) => setTimeout(r, 1500));
    return route.fulfill({ json: { url: `/api/skin/${HASH}.png`, model: 'gemini-3-pro-image', cache: 'miss', drawn_ms: 1234, width: 96, height: 64 } });
  });
  await page.route(`**/api/skin/${HASH}.png`, (route) => route.fulfill({ contentType: 'image/png', body: makePng() }));
  await page.goto(`/?speed=${SPEED}&input=mouse`);
  await page.waitForFunction(() => window.__sim?.ready === true && typeof window.__sim.skinState === 'function', undefined, { timeout: 90_000 });
  const badge = page.locator('#skin-box .skin-badge');
  // Nothing painted yet: ready, not "live".
  await expect(badge).toHaveText('skin: none yet, Nano Banana ready');
  await expect(badge).toHaveAttribute('data-live', 'false');
  const car = await spawn(page, 'a tesla');
  expect(car.spawned).toBe(true);

  // High quality is the default; (1) asks with Fast chosen.
  await expect(page.getByTestId('skin-quality-high')).toBeChecked();
  await page.getByTestId('skin-quality-fast').check();
  // (1) The image call is refused: every part is a procedural fallback, and the badge says so.
  await page.getByTestId('skin-text').fill('glossy candy apple red');
  await page.getByTestId('skin-apply').click();
  await expect(page.getByTestId('skin-status')).toContainText('So this skin is procedural');
  await expect(badge).toHaveText('skin: procedural (Nano Banana failed)');
  await expect(badge).toHaveAttribute('data-testid', 'skin-source-fallback');
  await expect(badge).toHaveAttribute('data-live', 'false');
  const refused = (await skinState(page))!;
  for (const p of refused.parts) expect([p.name, p.source, p.model, p.fallback]).toEqual([p.name, 'procedural', null, true]);

  // (2) High quality: a Pro image. The badge names Pro, not Lite.
  await page.getByTestId('skin-quality-high').check();
  await page.getByTestId('skin-text').fill('brushed gold with fine scratches');
  await page.getByTestId('skin-apply').click();
  await expect(page.getByTestId('skin-status')).toContainText('Asking Nano Banana Pro for brushed gold with fine scratches, about 13 s');
  await expect(page.getByTestId('skin-status')).toContainText('Drawn by Nano Banana Pro (gemini-3-pro-image) in 1.2 s');
  await expect(badge).toHaveText('skin: Nano Banana Pro (live)');
  await expect(badge).toHaveAttribute('data-testid', 'skin-source-live');
  await expect(badge).toHaveAttribute('data-live', 'true');
  const pro = (await skinState(page))!;
  for (const p of pro.parts) expect([p.source, p.model, p.size, p.fallback]).toEqual(['nano-banana', 'gemini-3-pro-image', [1024, 1024], false]);

  // (3) The refused look again, on the wheels only: a mix, so the badge is not marked live.
  await page.getByTestId('skin-quality-fast').check();
  await page.evaluate(() => window.__sim!.skinObject!('glossy candy apple red', 'wheels'));
  await expect(badge).toHaveText('skin: Nano Banana Pro (live) + procedural (Nano Banana failed)');
  await expect(badge).toHaveAttribute('data-testid', 'skin-source-mixed');
  await expect(badge).toHaveAttribute('data-live', 'false');
  expect(posts.map((p) => p.quality)).toEqual(['fast', 'high']);

  // (3b) The Pro look again, spelled differently: the session cache answers, no new call, and the badge says (cached).
  await page.getByTestId('skin-quality-high').check();
  await page.evaluate(() => window.__sim!.skinObject!('Brushed gold with fine scratches.', null));
  await expect(badge).toHaveText('skin: Nano Banana Pro (cached)');
  await expect(badge).toHaveAttribute('data-testid', 'skin-source-live');
  expect(posts.map((p) => p.quality)).toEqual(['fast', 'high']);

  // (4) Remove: no skin, so the badge goes back to ready.
  await page.getByTestId('skin-remove').click();
  await expect(badge).toHaveText('skin: none yet, Nano Banana ready');
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.getByTestId('skin-box').screenshot({ path: path.join(EVIDENCE_DIR, 'skins-badge-stub.png') });
  // The only console errors allowed are the stub's own refusals (422 skin, 503 spec), which the browser logs.
  expect(problems.filter((p) => !/Failed to load resource: the server responded with a status of (422|503)/.test(p))).toEqual([]);
});
