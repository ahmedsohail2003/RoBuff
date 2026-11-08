// Live talk: the hands-free "Talk live" mode. Headless Chrome has no microphone, so a fake
// SpeechRecognition stands in for the browser's (it records how it was set up and when it was
// started and aborted), and lines are injected with the liveHear test hook, which feeds the same
// path a final recognition result takes.
// Test 1 stubs the key server (health, /api/chat, /api/spec) so it runs anywhere. Test 2 is the
// live check through the real key server and is skipped unless LIVE_TALK_REAL=1.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';
import { watchProblems } from './pickRun';

const EVIDENCE_DIR = path.resolve(process.env.EVIDENCE_DIR ?? path.join(import.meta.dirname, '../evidence'));
// Audio may play without a click (the live check measures the first ElevenLabs audio); the config's WebGL switch is kept.
const webglArgs = process.env.E2E_WEBGL === 'software' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [];
test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', ...webglArgs] } });

/** Installs a fake SpeechRecognition before the app loads (or removes recognition entirely). */
async function fakeRecognition(page: Page, supported = true): Promise<void> {
  await page.addInitScript((has) => {
    const w = window as unknown as Record<string, unknown>;
    if (!has) {
      delete w.SpeechRecognition;
      delete w.webkitSpeechRecognition;
      Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined, configurable: true });
      return;
    }
    const recs: Record<string, unknown>[] = [];
    w.__recs = recs;
    class FakeRecognition {
      lang = '';
      continuous = false;
      interimResults = true;
      started = 0;
      aborted = 0;
      onresult: unknown = null;
      onerror: unknown = null;
      onend: (() => void) | null = null;
      constructor() {
        recs.push(this as unknown as Record<string, unknown>);
      }
      start() {
        this.started++;
      }
      stop() {
        setTimeout(() => this.onend?.(), 0);
      }
      abort() {
        this.aborted++;
        setTimeout(() => this.onend?.(), 0);
      }
    }
    w.SpeechRecognition = FakeRecognition;
    w.webkitSpeechRecognition = FakeRecognition;
  }, supported);
}

async function ready(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => window.__sim?.ready === true && typeof window.__sim.liveHear === 'function' && typeof window.__sim.spawnObject === 'function', undefined, {
    timeout: 90_000,
  });
}

async function listening(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(() => window.__sim!.liveState!().state === 'listening', undefined, { timeout });
}

/** Waits until it is listening, then injects one final transcript. */
async function hear(page: Page, text: string) {
  await listening(page);
  const turn = await page.evaluate((t) => window.__sim!.liveHear!(t), text);
  expect(turn, `"${text}" was not heard (live talk not listening)`).not.toBeNull();
  return turn!;
}

const fulfilJson = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

test('Talk live: keyboard toggle, continuous restart, paused while speaking, grammar first, /api/chat for the rest', async ({ page }) => {
  test.setTimeout(300_000);
  const problems: string[] = [];
  watchProblems(page, problems);
  const chatBodies: { text: string; history: unknown[]; state: Record<string, unknown> }[] = [];
  await page.route('**/api/health', (route) => fulfilJson(route, { ok: true, gemini: 'configured', elevenlabs: 'missing' }));
  const specTexts: string[] = [];
  await page.route('**/api/spec', (route) => {
    // A tennis ball at real size in solid aluminium (the guardrail refuses it for weight), or the
    // size the text asks for, as Gemini quotes the size asked.
    const text = String((route.request().postDataJSON() as { text?: string }).text ?? '');
    specTexts.push(text);
    const asked = /(\d+) millimetres across/.exec(text);
    const mm = asked ? Number(asked[1]) : 67;
    return fulfilJson(route, {
      source: 'gemini',
      model: 'stub',
      intent: 'spawn',
      gravity: null,
      spec: { kind: 'sphere', name: 'tennis ball', width_mm: mm, height_mm: mm, roughness: 0.1, lumpiness: 0, seed: 1, material: 'aluminium', color: '#d7e83a', why: 'A tennis ball as a sphere.' },
      latency_ms: 5,
    });
  });
  await page.route('**/api/chat', (route) => {
    const body = route.request().postDataJSON() as (typeof chatBodies)[number];
    chatBodies.push(body);
    const text = body.text.toLowerCase();
    if (text.includes('gravity on the moon')) return fulfilJson(route, { source: 'gemini', reply: 'The Moon setting in this simulation is 1.62 metres per second squared.', action: { type: 'none' }, latency_ms: 3 });
    if (text.includes('lunar surface')) return fulfilJson(route, { source: 'gemini', reply: 'Heading for the Moon, in simulation.', action: { type: 'gravity', value: 'moon' }, latency_ms: 3 });
    if (text.includes('whip up')) return fulfilJson(route, { source: 'gemini', reply: 'Making a tennis ball; the guardrail and lift test check it in simulation.', action: { type: 'spawn', value: 'a tennis ball' }, latency_ms: 3 });
    return fulfilJson(route, { source: 'gemini', reply: 'Mission control here.', action: { type: 'none' }, latency_ms: 3 });
  });
  await fakeRecognition(page);
  // Not muted: the browser voice (or its timer) keeps "speaking" true long enough to see the pause.
  await ready(page, '/');

  await expect(page.getByTestId('live-badge')).toHaveText('Live talk: Gemini 3.8 Flash (live)');
  await expect(page.getByTestId('mic-badge')).toHaveText('speech-to-text: browser (needs network)');
  const live = page.getByTestId('voice-live');
  await expect(live).toHaveText('Talk live');
  await expect(live).toHaveAttribute('aria-pressed', 'false');

  // Keyboard: Tab reaches it from Hold to talk; Enter turns it on.
  await page.getByTestId('voice-talk').focus();
  await page.keyboard.press('Tab');
  await expect(live).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(live).toHaveAttribute('aria-pressed', 'true');
  await expect(live).toHaveText('Live: listening...');
  const setup = await page.evaluate(() => (window as unknown as { __recs: Record<string, unknown>[] }).__recs.map((r) => ({ continuous: r.continuous, interimResults: r.interimResults, lang: r.lang, started: r.started })));
  expect(setup).toEqual([{ continuous: true, interimResults: false, lang: 'en-US', started: 1 }]);
  const pulse = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="voice-live"] .dot')!).animationName);
  expect(pulse).toBe('live-pulse');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="voice-live"] .dot')!).animationName)).toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // The browser ends a session: live talk starts a new one by itself.
  await page.evaluate(() => {
    const recs = (window as unknown as { __recs: { onend: (() => void) | null }[] }).__recs;
    recs[recs.length - 1]!.onend?.();
  });
  await page.waitForFunction(() => window.__sim!.liveState!().starts === 2, undefined, { timeout: 5_000 });

  // 1. A question the grammar does not know goes to /api/chat; the reply is captioned and spoken.
  const startsBefore = (await page.evaluate(() => window.__sim!.liveState!())).starts;
  const moon = await hear(page, "what's the gravity on the moon?");
  expect(moon).toMatchObject({ by: 'chat', grammar: 'unknown', action: { type: 'none' } });
  expect(moon.reply).toContain('1.62');
  await expect(page.getByTestId('caption')).toContainText('1.62');
  expect(chatBodies[0]).toMatchObject({ text: "what's the gravity on the moon?", history: [], state: { mode: 'direct', gravity: 'earth', lastObject: null, stopped: false } });
  // While RoBuff speaks the ears are off; they come back after.
  await expect(live).toHaveText('Live: paused while RoBuff speaks');
  const aborted = await page.evaluate(() => (window as unknown as { __recs: { aborted: number }[] }).__recs.some((r) => r.aborted > 0));
  expect(aborted).toBe(true);
  expect(await page.evaluate(() => window.__sim!.liveHear!('heard while speaking'))).toBeNull();
  await listening(page);
  await expect(live).toHaveText('Live: listening...');
  expect((await page.evaluate(() => window.__sim!.liveState!())).starts).toBeGreaterThan(startsBefore);

  // 2. A grammar line: no chat call.
  const mars = await hear(page, 'switch to Mars');
  expect(mars.by).toBe('grammar');
  expect(chatBodies).toHaveLength(1);
  expect((await page.evaluate(() => window.__sim!.gravity!())).preset.value).toBe(3.73);

  // 3. Chat actions run through the grammar's handlers: gravity, then a spawn through the object panel.
  const lunar = await hear(page, 'take me to the lunar surface');
  expect(lunar.action).toEqual({ type: 'gravity', value: 'moon' });
  expect((await page.evaluate(() => window.__sim!.gravity!())).preset.value).toBe(1.62);
  expect(chatBodies[1]!.history.length).toBeGreaterThan(0);
  expect(chatBodies[1]!.state.gravity).toBe('mars');
  const ball = await hear(page, 'could you whip up a tennis ball');
  expect(ball.action).toEqual({ type: 'spawn', value: 'a tennis ball' });
  await page.waitForFunction(() => window.__sim!.lastOutcome !== null && window.__sim!.objectBusy === false, undefined, { timeout: 60_000 });
  const spawnResult = (await page.evaluate(() => window.__sim!.voiceResults!())).find((r) => r.action.type === 'object');
  expect(spawnResult).toMatchObject({ action: { type: 'object', text: 'a tennis ball' }, by: 'gemini', network: true });
  // The 67 mm solid aluminium ball is refused for weight; live talk asks once for the guardrail's
  // own lighter size, through the same object panel, and that request is checked and lift-tested.
  await page.waitForFunction(
    () => window.__sim!.voiceResults!().filter((r) => r.action.type === 'object').length === 2 && window.__sim!.objectBusy === false,
    undefined,
    { timeout: 90_000 },
  );
  const objectResults = (await page.evaluate(() => window.__sim!.voiceResults!())).filter((r) => r.action.type === 'object');
  const followUp = (await page.evaluate(() => window.__sim!.liveTurns!())).find((t) => t.followUp)?.followUp;
  expect(followUp).toMatch(/^a tennis ball, \d+ millimetres across, in solid aluminium$/);
  expect(objectResults[1]!.action).toEqual({ type: 'object', text: followUp });
  expect(specTexts).toEqual(['a tennis ball', followUp]);
  const captions = await page.evaluate(() => window.__sim!.voiceCaptions!().map((c) => c.text));
  expect(captions.some((t) => /^Refused[:.] .*At \d+ millimetres across it would be \d+ grams\. Ask for that/.test(t))).toBe(true);
  expect(captions.some((t) => t.startsWith("So I'll ask for that: "))).toBe(true);
  const smaller = (await page.evaluate(() => window.__sim!.lastOutcome)) as { spawned: boolean; receipt: { verdict: string; mass_kg: number } };
  expect(smaller.receipt.mass_kg * 1000).toBeLessThan(200);
  expect(smaller.spawned, JSON.stringify(smaller.receipt.verdict)).toBe(true);
  await expect(page.getByTestId('object-verdict')).toHaveAttribute('data-verdict', /PASS|ADJUSTED/);

  // 4. "stop": acted on at once by the grammar, no /api/chat request.
  await page.evaluate(() => window.__sim!.pickObject!());
  const chatCount = chatBodies.length;
  // Headless Chrome's browser voice has no voices, so each queued line holds the ears off for its
  // fallback timer (400 ms + 90 ms a character): the refusal, the follow-up line and the receipt
  // together take longer than the default 30 s wait.
  await listening(page, 120_000);
  const stop = await hear(page, 'stop');
  expect(stop.by).toBe('grammar');
  expect(await page.evaluate(() => window.__sim!.stopped)).toBe(true);
  expect(chatBodies).toHaveLength(chatCount);

  await page.locator('#voice-panel').screenshot({ path: path.join(EVIDENCE_DIR, 'live-talk-stub.png') }).catch(() => undefined);

  // 5. Off: everything stops; no new sessions start.
  await listening(page);
  await live.click();
  await expect(live).toHaveAttribute('aria-pressed', 'false');
  await expect(live).toHaveText('Talk live');
  const startsOff = (await page.evaluate(() => window.__sim!.liveState!())).starts;
  await page.waitForTimeout(1500);
  expect((await page.evaluate(() => window.__sim!.liveState!())).starts).toBe(startsOff);
  expect(await page.evaluate(() => window.__sim!.liveHear!('make me a cube'))).toBeNull();

  await page.evaluate(() => window.__sim!.clearStop!());
  expect(problems).toEqual([]);
});

test('Talk live without speech recognition: the button explains and stays off; offline label', async ({ page }) => {
  await page.route('**/api/health', (route) => fulfilJson(route, { ok: false, gemini: 'missing', elevenlabs: 'missing' }));
  await fakeRecognition(page, false);
  await ready(page, '/?mute=1');
  const live = page.getByTestId('voice-live');
  await expect(live).toHaveText('Talk live (not in this browser)');
  await expect(page.getByTestId('live-badge')).toHaveText('Live talk: offline (grammar only)');
  await live.click();
  await expect(live).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('live-note')).toContainText('does not have');
});

// The live check: real key server (Gemini and ElevenLabs), fake microphone, injected lines.
test.describe('live check (real key server)', () => {
  test.skip(process.env.LIVE_TALK_REAL !== '1', 'set LIVE_TALK_REAL=1 with the key server running');

  test('real Gemini replies, ElevenLabs audio, spawn, gravity, stop', async ({ page }) => {
    test.setTimeout(240_000);
    const problems: string[] = [];
    watchProblems(page, problems);
    const requests: { url: string; at: number }[] = [];
    page.on('request', (r) => requests.push({ url: r.url(), at: Date.now() }));
    await fakeRecognition(page);
    await ready(page, '/');
    await page.waitForFunction(() => window.__sim!.voiceBadges!().live === 'Live talk: Gemini 3.8 Flash (live)', undefined, { timeout: 15_000 });
    await page.getByTestId('voice-live').click();
    await listening(page);
    const rows: Record<string, unknown>[] = [];
    /** Waits for the caption to have played (via known) and returns its first-audio ms. */
    const audio = async (captionText: string | null) =>
      page.waitForFunction(
        (t) => {
          const caps = window.__sim!.voiceCaptions!();
          const c = t ? [...caps].reverse().find((x) => x.text === t) : caps[caps.length - 1];
          if (!c || !c.via) return null;
          // Where the first-audio time went: each /api/tts fetch for this line, in ms after the
          // line was said (request sent, first byte, last byte), from the browser's resource timing.
          const tts = performance
            .getEntriesByType('resource')
            .filter((e) => e.name.includes('/api/tts') && e.startTime >= c.atMs - 1)
            .map((e) => {
              const r = e as PerformanceResourceTiming;
              return { startMs: Math.round(r.startTime - c.atMs), firstByteMs: Math.round(r.responseStart - c.atMs), lastByteMs: Math.round(r.responseEnd - c.atMs) };
            });
          return { text: c.text, via: c.via, firstAudioMs: c.firstAudioMs, error: c.error, tts };
        },
        captionText,
        { timeout: 60_000 },
      ).then((h) => h.jsonValue());

    // 1. A question for Gemini.
    let mark = Date.now();
    const moon = await hear(page, "what's the gravity on the moon?");
    const moonAudio = await audio(moon.captionText);
    const moonCaption = (await page.getByTestId('caption').textContent()) ?? '';
    rows.push({ line: "what's the gravity on the moon?", by: moon.by, reply: moon.reply, action: moon.action, chatMs: moon.chatMs, serverMs: moon.serverMs, audio: moonAudio, caption: moonCaption, ttsRequests: requests.filter((r) => r.at >= mark && r.url.includes('/api/tts')).length });
    expect(moon.by).toBe('chat');
    expect(moon.reply).toContain('1.62');

    // 2. An object, through the object panel.
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'live-talk-page.png') });
    type Outcome = { spawned: boolean; source: string; receipt: { verdict: string; mass_kg?: number | null; spec?: Record<string, unknown>; steps?: { action: string; message: string }[] } };
    const objectRow = async (line: string) => {
      mark = Date.now();
      const before = await page.evaluate(() => window.__sim!.voiceResults!().length);
      const turn = await hear(page, line);
      await page.waitForFunction((n) => window.__sim!.voiceResults!().length > n && window.__sim!.objectBusy === false && window.__sim!.lastOutcome !== null, before, { timeout: 90_000 });
      const outcome = (await page.evaluate(() => window.__sim!.lastOutcome)) as Outcome;
      const said = await audio(null);
      rows.push({ line, by: turn.by, chatCalls: requests.filter((r) => r.at >= mark && r.url.includes('/api/chat')).length, spawned: outcome.spawned, source: outcome.source, verdict: outcome.receipt?.verdict, refusedBy: outcome.receipt?.steps?.find((s) => s.action === 'refused')?.message ?? null, spec: outcome.receipt?.spec ?? null, followUp: turn.followUp, mass_g: outcome.receipt?.mass_kg != null ? outcome.receipt.mass_kg * 1000 : null, body: await page.evaluate(() => window.__sim!.objectBodyName), audio: said });
      return outcome;
    };
    const ball = await objectRow('make me a tennis ball');
    // The guardrail may refuse (then nothing spawns): that is the panel path working, reported as is,
    // and a second object shows a spawn through the same voice path.
    expect.soft(ball.spawned, JSON.stringify(rows.at(-1))).toBe(true);
    if (!ball.spawned) expect((await objectRow('make me a 40 millimetre aluminium cube')).spawned).toBe(true);

    // 3. Gravity by voice.
    mark = Date.now();
    const mars = await hear(page, 'switch to Mars');
    const marsAudio = await audio(null);
    const g = await page.evaluate(() => window.__sim!.gravity!());
    rows.push({ line: 'switch to Mars', by: mars.by, gravity: g.preset.value, sims: g.sims, chatCalls: requests.filter((r) => r.at >= mark && r.url.includes('/api/chat')).length, audio: marsAudio });
    expect(g.preset.value).toBe(3.73);

    // 4. Stop, with the arm moving.
    await page.evaluate(() => window.__sim!.pickObject!());
    await page.waitForTimeout(1500);
    mark = Date.now();
    const stop = await hear(page, 'stop');
    const at0 = await page.evaluate(() => ({ t: window.__sim!.simTime, ctrl: window.__sim!.getCtrl(), stopped: window.__sim!.stopped }));
    await page.waitForFunction((t) => window.__sim!.simTime > t + 0.5, at0.t);
    const at1 = await page.evaluate(() => ({ t: window.__sim!.simTime, ctrl: window.__sim!.getCtrl() }));
    const stopAudio = await audio(null);
    const ctrlChange = Math.max(...at0.ctrl.map((v, i) => Math.abs(v - at1.ctrl[i]!)));
    rows.push({ line: 'stop', by: stop.by, stopped: at0.stopped, ctrlChangeOver: at1.t - at0.t, ctrlChange, chatCalls: requests.filter((r) => r.at >= mark && r.url.includes('/api/chat')).length, audio: stopAudio });
    expect(at0.stopped).toBe(true);
    expect(ctrlChange).toBe(0);

    await listening(page);
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const shot = process.env.LIVE_TALK_SHOT ?? path.join(EVIDENCE_DIR, 'live-talk.png');
    await page.locator('#voice-panel').screenshot({ path: shot });
    const report = { rows, badges: await page.evaluate(() => window.__sim!.voiceBadges!()), turns: await page.evaluate(() => window.__sim!.liveTurns!()), captions: await page.evaluate(() => window.__sim!.voiceCaptions!()), problems };
    writeFileSync(path.join(EVIDENCE_DIR, 'live-talk-real.json'), JSON.stringify(report, null, 2));
    console.log(`LIVE_TALK ${JSON.stringify(report)}`);
    await page.evaluate(() => window.__sim!.clearStop!());
  });
});
