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

test('mode object: the object panel always gets a spawn spec, even when Gemini answers none; commands keep none', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const reply = { intent: 'none', gravity: 'none', kind: 'box', width_mm: 1900, height_mm: 1450, roughness: 0.1, lumpiness: 0.2, seed: 4, material: 'aluminium', color: '#e82127', why: 'Approximated: a Tesla, as a car-shaped box.' };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }), { status: 200 });
  };
  const { base } = await start({ config: FAKE_KEYS, fetchImpl });
  const panel = await (await post(base, '/api/spec', { text: 'Tesla', mode: 'object' })).json();
  assert.equal(panel.intent, 'spawn');
  assert.equal(panel.spec.kind, 'box');
  assert.match(panel.spec.why, /^Approximated:/);
  assert.match(calls[0].systemInstruction.parts[0].text, /object panel/);
  const command = await (await post(base, '/api/spec', { text: 'Tesla' })).json();
  assert.equal(command.intent, 'none');
  assert.equal(command.spec, null);
  assert.doesNotMatch(calls[1].systemInstruction.parts[0].text, /object panel/);
});

// ---- POST /api/chat (live talk) ----

const geminiReply = (obj) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }), { status: 200 });

test('chat with no key: 503 with a plain message, and the route is listed', async () => {
  const { base, lines } = await start({ config: NO_KEYS });
  const res = await post(base, '/api/chat', { text: "what's the gravity on the moon?", history: [], state: { mode: 'direct', gravity: 'earth', lastObject: null, stopped: false } });
  assert.equal(res.status, 503);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  assert.match(await res.text(), /Gemini is not configured.*offline commands/);
  assert.match(await (await fetch(`${base}/nope`)).text(), /POST \/api\/chat/);
  assert.ok(lines.some((l) => l.startsWith('POST /api/chat 503')));
});

test('chat with a stubbed Gemini: { reply, action }; state and history reach the prompt; the key stays in a header', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return geminiReply({ reply: 'On the Moon the simulation uses 1.62 metres per second squared.', action: { type: 'none' } });
  };
  const { base, lines } = await start({ config: FAKE_KEYS, fetchImpl });
  const history = Array.from({ length: 9 }, (_, i) => ({ role: i % 2 ? 'robuff' : 'user', text: `turn ${i}` }));
  const res = await post(base, '/api/chat', { text: "what's the gravity on the moon?", history, state: { mode: 'moon_ghost_on', gravity: 'mars', lastObject: 'a tennis ball', stopped: false } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.source, 'gemini');
  assert.equal(body.model, 'gemini-3.8-flash');
  assert.equal(body.reply, 'On the Moon the simulation uses 1.62 metres per second squared.');
  assert.deepEqual(body.action, { type: 'none' });
  assert.equal(typeof body.latency_ms, 'number');
  const sent = calls[0].body;
  assert.match(calls[0].url, /gemini-3\.8-flash:generateContent$/);
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'test-gemini-value');
  assert.ok(!calls[0].url.includes('test-gemini-value'));
  assert.match(sent.systemInstruction.parts[0].text, /RoBuff mission control/);
  assert.match(sent.systemInstruction.parts[0].text, /in simulation/);
  assert.deepEqual(sent.generationConfig.responseJsonSchema.required, ['reply', 'action']);
  assert.deepEqual(sent.generationConfig.responseJsonSchema.properties.action.properties.type.enum, ['spawn', 'gravity', 'mode', 'home', 'none']);
  const prompt = sent.contents[0].parts[0].text;
  assert.match(prompt, /"mode":"moon_ghost_on","gravity":"mars","lastObject":"a tennis ball","stopped":false/);
  assert.match(prompt, /Operator now: what's the gravity on the moon\?/);
  // Only the last 6 turns go to the model.
  assert.ok(!prompt.includes('turn 2'));
  for (let i = 3; i < 9; i++) assert.ok(prompt.includes(`turn ${i}`));
  assert.ok(lines.every((l) => !l.includes('test-')));
  assert.ok(!JSON.stringify(body).includes('test-gemini-value'));
});

test('chat: actions are checked, the reply is cut to 200 characters, bad JSON is a 502', async () => {
  const answers = [
    { reply: 'Switching to Mars in simulation.', action: { type: 'gravity', value: 'Mars' } },
    { reply: 'Making it.', action: { type: 'spawn', value: '  a tennis ball ' } },
    { reply: 'Delay on.', action: { type: 'mode', value: 'moon_ghost_on' } },
    { reply: 'Home.', action: { type: 'home', value: 'ignored' } },
    { reply: 'No.', action: { type: 'gravity', value: 'jupiter' } },
    { reply: 'No.', action: { type: 'stop' } },
    { reply: `${'Word '.repeat(30)}first. ${'More words here '.repeat(20)}`, action: { type: 'none' } },
  ];
  let n = 0;
  const fetchImpl = async () => (n < answers.length ? geminiReply(answers[n++]) : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }), { status: 200 }));
  const { base } = await start({ config: FAKE_KEYS, fetchImpl });
  const ask = async () => (await post(base, '/api/chat', { text: 'something the grammar does not know' })).json();
  assert.deepEqual((await ask()).action, { type: 'gravity', value: 'mars' });
  assert.deepEqual((await ask()).action, { type: 'spawn', value: 'a tennis ball' });
  assert.deepEqual((await ask()).action, { type: 'mode', value: 'moon_ghost_on' });
  assert.deepEqual((await ask()).action, { type: 'home' });
  assert.deepEqual((await ask()).action, { type: 'none' });
  assert.deepEqual((await ask()).action, { type: 'none' });
  const long = await ask();
  assert.ok(long.reply.length <= 200, `reply is ${long.reply.length} characters`);
  assert.match(long.reply, /first\.$/);
  const bad = await post(base, '/api/chat', { text: 'x' });
  assert.equal(bad.status, 502);
  assert.match(await bad.text(), /did not return JSON/);
  assert.equal((await post(base, '/api/chat', { text: '' })).status, 400);
});

test('chat shares the limits: the per-IP rate and the daily Gemini cap', async () => {
  const fetchImpl = async () => geminiReply({ reply: 'Hello from mission control.', action: { type: 'none' } });
  const { base } = await start({ config: FAKE_KEYS, fetchImpl, limits: createLimits({ perMinute: 3, specPerDay: 2 }) });
  assert.equal((await post(base, '/api/chat', { text: 'hi' })).status, 200);
  assert.equal((await post(base, '/api/chat', { text: 'hi' })).status, 200);
  const capped = await post(base, '/api/chat', { text: 'hi' });
  assert.equal(capped.status, 429);
  assert.match(await capped.text(), /Gemini cap is used up/);
  const limited = await post(base, '/api/chat', { text: 'hi' });
  assert.equal(limited.status, 429);
  assert.match(await limited.text(), /30 a minute|a minute/);
});

test("chat prompt quotes the app's own gravity presets (web/src/objects/limits.ts)", async () => {
  const { readFileSync } = await import('node:fs');
  const { CHAT_SYSTEM_PROMPT } = await import('../index.mjs');
  const source = readFileSync(new URL('../../web/src/objects/limits.ts', import.meta.url), 'utf8');
  const block = /export const GRAVITY = \{([^}]*)\}/.exec(source)?.[1] ?? '';
  const value = (name) => Number(new RegExp(`${name}:\\s*([0-9.e-]+)`).exec(block)?.[1]);
  assert.match(CHAT_SYSTEM_PROMPT, new RegExp(`Earth ${value('earth')}, Mars ${value('mars')}, Moon ${value('moon')}`));
  assert.equal(value('bennu'), 0.000083);
  assert.match(CHAT_SYSTEM_PROMPT, /Bennu 0\.000083/);
  assert.equal(value('orbit'), 0);
});
