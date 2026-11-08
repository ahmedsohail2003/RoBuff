// Live check for voice motion through a real key server (Gemini chat, ElevenLabs voice), using
// the Talk live transcript hook (headless Chrome has no microphone). Skipped unless
// VOICE_MOTION_LIVE=1 with a key server on KEY_SERVER_PORT. One line goes to Gemini.
// Disclosure: the transcripts are injected through liveHear with a fake SpeechRecognition, so no
// microphone is involved. Gemini and ElevenLabs are real.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { watchProblems } from './pickRun';

const OUT = path.resolve(process.env.VOICE_LIVE_OUT ?? path.join(import.meta.dirname, '../evidence/voice-motion'));
test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });
type V3 = [number, number, number];

async function fakeRecognition(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    class FakeRecognition {
      lang = '';
      continuous = false;
      interimResults = true;
      onresult: unknown = null;
      onerror: unknown = null;
      onend: (() => void) | null = null;
      start() {}
      stop() {
        setTimeout(() => this.onend?.(), 0);
      }
      abort() {
        setTimeout(() => this.onend?.(), 0);
      }
    }
    w.SpeechRecognition = FakeRecognition;
    w.webkitSpeechRecognition = FakeRecognition;
  });
}

test.describe('voice motion live check (real key server)', () => {
  test.skip(process.env.VOICE_MOTION_LIVE !== '1', 'set VOICE_MOTION_LIVE=1 with a key server on KEY_SERVER_PORT');

  test('grammar moves, a Gemini pick-and-lift, put down, stop', async ({ page }) => {
    test.setTimeout(240_000);
    const problems: string[] = [];
    watchProblems(page, problems);
    const chats: { at: number; body: string }[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/chat')) chats.push({ at: Date.now(), body: r.postData() ?? '' });
    });
    await fakeRecognition(page);
    await page.goto('/?input=mouse');
    await page.waitForFunction(() => window.__sim?.ready === true && typeof window.__sim.liveHear === 'function' && typeof window.__sim.voiceMotion === 'function', undefined, { timeout: 90_000 });
    await page.waitForFunction(() => window.__sim!.voiceBadges!().live === 'Live talk: Gemini 3.8 Flash (live)', undefined, { timeout: 15_000 });
    await page.getByTestId('voice-live').click();
    const screen = await page.evaluate(() => window.__sim!.screen());
    const rows: Record<string, unknown>[] = [];

    const hear = async (text: string) => {
      await page.waitForFunction(() => window.__sim!.liveState!().state === 'listening', undefined, { timeout: 30_000 });
      const before = await page.evaluate(() => ({ site: window.__sim!.getSitePos('gripper') as V3, obj: window.__sim!.voiceObject!(), caps: window.__sim!.voiceCaptions!().length, chats: 0 }));
      const nChats = chats.length;
      const t0 = Date.now();
      const { turn, heardAt } = await page.evaluate(async (t) => {
        const at = performance.now();
        return { turn: await window.__sim!.liveHear!(t), heardAt: at };
      }, text);
      expect(turn, `"${text}" was not heard`).not.toBeNull();
      // Let the last line start playing, so its first-audio time is known.
      await page.waitForTimeout(1500);
      const after = await page.evaluate((n) => {
        const caps = window.__sim!.voiceCaptions!().slice(n);
        return { site: window.__sim!.getSitePos('gripper') as V3, obj: window.__sim!.voiceObject!(), caps, stopped: window.__sim!.stopped };
      }, before.caps);
      const d: V3 = [after.site[0] - before.site[0], after.site[1] - before.site[1], after.site[2] - before.site[2]];
      const left = -(d[0] * screen.right[0] + d[1] * screen.right[1]);
      const first = after.caps.find((c) => c.firstAudioMs !== null) ?? after.caps[0] ?? null;
      const row = {
        line: text,
        path: turn!.by,
        chat_calls: chats.length - nChats,
        chat_ms: turn!.chatMs === null ? null : Math.round(turn!.chatMs),
        server_ms: turn!.serverMs,
        actions: turn!.actions,
        ran: turn!.ran,
        motion_mm: { left: Math.round(left * 10000) / 10, up: Math.round(d[2] * 10000) / 10 },
        object: after.obj ? { rise_mm: before.obj ? Math.round((after.obj.com[2] - before.obj.com[2]) * 10000) / 10 : null, com_z_mm: Math.round(after.obj.com[2] * 10000) / 10, lowest_mm: Math.round(after.obj.lowest * 10000) / 10, jaws: after.obj.jaws, holding: after.obj.holding } : null,
        captions: after.caps.map((c) => `${c.text} [${c.via ?? '-'}]`),
        first_audio_ms: first?.firstAudioMs ?? null,
        // From the moment the line was heard (liveHear called) to the first audio of any line.
        heard_to_first_audio_ms: first && first.firstAudioMs !== null ? Math.round(first.atMs + first.firstAudioMs - heardAt) : null,
        reply: turn!.reply,
        stopped: after.stopped,
        wall_ms: Date.now() - t0,
      };
      rows.push(row);
      console.log(`VOICE_LIVE_ROW ${JSON.stringify(row)}`);
      return row;
    };

    mkdirSync(OUT, { recursive: true });
    const a = await hear('move left five centimetres');
    expect(a.path).toBe('grammar');
    expect(a.chat_calls).toBe(0);
    expect(a.motion_mm.left).toBeGreaterThanOrEqual(45);
    expect(a.motion_mm.left).toBeLessThanOrEqual(55);
    const b = await hear('go up a bit');
    expect(b.path).toBe('grammar');
    expect(b.chat_calls).toBe(0);
    expect(b.motion_mm.up).toBeGreaterThanOrEqual(15);
    expect(b.motion_mm.up).toBeLessThanOrEqual(25);
    await page.locator('#voice-panel').screenshot({ path: path.join(OUT, 'voice-panel-live.png') });
    const c = await hear('could you grab the cube and lift it a little higher');
    expect(c.path).toBe('chat');
    expect(c.chat_calls).toBe(1);
    expect((c.actions as { type: string; value?: string }[]).map((x) => x.type)).toEqual(['pick', 'move']);
    expect(String((c.actions as { type: string; value?: string }[])[1]!.value)).toMatch(/\bup\b/);
    expect(c.ran).toEqual(['pick', 'move']);
    expect(c.object!.rise_mm!).toBeGreaterThanOrEqual(48);
    expect(c.object!.jaws).toEqual(['Fixed_Jaw', 'Moving_Jaw']);
    expect(c.object!.holding).toBe(true);
    await page.screenshot({ path: path.join(OUT, 'arm-holding-cube.png') });
    const d = await hear('put it down');
    expect(d.path).toBe('grammar');
    expect(d.chat_calls).toBe(0);
    expect(d.object!.lowest_mm).toBeLessThan(5);
    expect(d.object!.jaws).toEqual([]);
    const e = await hear('stop');
    expect(e.path).toBe('grammar');
    expect(e.chat_calls).toBe(0);
    expect(e.stopped).toBe(true);
    await page.locator('#voice-panel').screenshot({ path: path.join(OUT, 'voice-panel-after-stop.png') });
    writeFileSync(path.join(OUT, 'live-check.json'), JSON.stringify({ rows, problems, health: await page.evaluate(() => window.__sim!.voiceBadges!()) }, null, 2));
  });
});
