// Routes with no keys (the state today) and with a fake upstream, so no test touches the network.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createAppServer } from '../index.mjs';
import { createLimits } from '../limits.mjs';

const NO_KEYS = { geminiKey: '', elevenKey: '', voiceId: '', allowedOrigins: [] };
const FAKE_KEYS = { geminiKey: 'test-gemini-value', elevenKey: 'test-eleven-value', voiceId: 'voice123', allowedOrigins: [] };
const servers = [];
const scratch = mkdtempSync(path.join(os.tmpdir(), 'aftergrip-server-test-'));
after(() => {
  for (const s of servers) s.close();
  rmSync(scratch, { recursive: true, force: true });
});

async function start(options) {
  const lines = [];
  const server = createAppServer({ log: (l) => lines.push(l), cacheDir: path.join(scratch, String(servers.length)), ...options });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, lines };
}

const post = (base, route, body, headers = {}) =>
  fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('no keys: health says missing, spec and tts answer 503 with a plain message', async () => {
  const { base, lines } = await start({ config: NO_KEYS });
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.gemini, 'missing');
  assert.equal(health.elevenlabs, 'missing');
  const spec = await post(base, '/api/spec', { text: 'an asteroid the size of Texas' });
  assert.equal(spec.status, 503);
  assert.match(spec.headers.get('content-type'), /text\/plain/);
  assert.match(await spec.text(), /Gemini is not configured/);
  const tts = await post(base, '/api/tts', { text: 'GO' });
  assert.equal(tts.status, 503);
  assert.match(await tts.text(), /ElevenLabs is not configured/);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.ok(lines.some((l) => l.startsWith('POST /api/spec 503')));
});

test('another web page is refused; the 31st request in a minute gets 429', async () => {
  const { base } = await start({ config: NO_KEYS, limits: createLimits({ perMinute: 30 }) });
  assert.equal((await post(base, '/api/spec', { text: 'x' }, { origin: 'https://evil.example' })).status, 403);
  for (let i = 0; i < 30; i++) assert.equal((await post(base, '/api/spec', { text: 'x' })).status, 503);
  const limited = await post(base, '/api/spec', { text: 'x' });
  assert.equal(limited.status, 429);
  assert.match(await limited.text(), /30 a minute/);
});

test('with a key: Gemini JSON becomes { source, intent, spec, latency_ms }; the key goes only in a header and never in the log', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const reply = { intent: 'spawn', gravity: 'none', kind: 'asteroid', width_mm: 1.2e9, height_mm: 1e9, roughness: 0.5, lumpiness: 0.5, seed: 3, material: 'c_type_rock', color: '#333333', why: 'Texas-sized.' };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }), { status: 200 });
  };
  const { base, lines } = await start({ config: FAKE_KEYS, fetchImpl });
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.gemini, 'configured');
  assert.ok(!JSON.stringify(health).includes('test-gemini-value'));
  const res = await post(base, '/api/spec', { text: 'an asteroid the size of Texas' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.source, 'gemini');
  assert.equal(body.intent, 'spawn');
  assert.equal(body.gravity, null);
  assert.equal(body.spec.width_mm, 1.2e9);
  assert.equal(typeof body.latency_ms, 'number');
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'test-gemini-value');
  assert.ok(!calls[0].url.includes('test-gemini-value'));
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(sent.generationConfig.responseJsonSchema.required.slice(0, 2), ['intent', 'gravity']);
  assert.ok(lines.every((l) => !l.includes('test-')));
});

test('a 400 from Gemini retries once with responseSchema; a 500 becomes a 502 plain message', async () => {
  let n = 0;
  const seen = [];
  const fetchImpl = async (_url, init) => {
    n++;
    seen.push(JSON.parse(init.body).generationConfig);
    if (n === 1) return new Response('bad', { status: 400 });
    return new Response('boom', { status: 500 });
  };
  const { base } = await start({ config: FAKE_KEYS, fetchImpl });
  const res = await post(base, '/api/spec', { text: 'home' });
  assert.equal(res.status, 502);
  assert.match(await res.text(), /HTTP 500/);
  assert.equal(n, 2);
  assert.ok('responseJsonSchema' in seen[0]);
  assert.equal(seen[1].responseSchema.type, 'OBJECT');
});

test('tts: over 160 characters is refused; a fixed line is fetched once, then served from the cache', async () => {
  let upstreamCalls = 0;
  const fetchImpl = async (url, init) => {
    upstreamCalls++;
    assert.match(url, /text-to-speech\/voice123\/stream/);
    assert.equal(JSON.parse(init.body).model_id, 'eleven_flash_v2_5');
    return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  };
  const cacheDir = path.join(scratch, 'cache');
  const { base } = await start({ config: FAKE_KEYS, fetchImpl, cacheDir });
  assert.equal((await post(base, '/api/tts', { text: 'x'.repeat(161) })).status, 400);
  const first = await post(base, '/api/tts', { text: 'GO', fixed: true });
  assert.equal(first.headers.get('x-voice-cache'), 'miss');
  assert.equal((await first.arrayBuffer()).byteLength, 4);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(readdirSync(cacheDir).length, 1);
  const second = await post(base, '/api/tts', { text: 'GO', fixed: true });
  assert.equal(second.headers.get('x-voice-cache'), 'hit');
  assert.equal((await second.arrayBuffer()).byteLength, 4);
  assert.equal(upstreamCalls, 1);
});
