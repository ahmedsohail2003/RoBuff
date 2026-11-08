// POST /api/skin and GET /api/skin/<hash> with a stubbed Google, so no test touches the network or costs money.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createAppServer } from '../index.mjs';
import { createLimits } from '../limits.mjs';
import { imageSize, normaliseSkinText, pickImage, SKIN_MODELS, skinCacheKey, skinPrompt, sniffImage } from '../skin.mjs';

const NO_KEYS = { geminiKey: '', elevenKey: '', voiceId: '', allowedOrigins: [] };
const FAKE_KEYS = { geminiKey: 'test-gemini-value', elevenKey: '', voiceId: '', allowedOrigins: [] };
const servers = [];
const scratch = mkdtempSync(path.join(os.tmpdir(), 'robuff-skin-test-'));
after(() => {
  for (const s of servers) s.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** A JPEG header the size parser reads: SOI, APP0, SOF0 1024 x 1024 with 3 components, EOI. */
function tinyJpeg(w = 1024, h = 1024) {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
}
const JPEG = tinyJpeg();
const SIGNATURE = 'SIG'.repeat(2000);

function imageAnswer(bytes = JPEG, mimeType = 'image/jpeg', extra = {}) {
  return { candidates: [{ content: { parts: [{ inlineData: { mimeType, data: bytes.toString('base64') }, thoughtSignature: SIGNATURE }] }, finishReason: 'STOP' }], ...extra };
}

/** A fake Google that records each call and answers with `answer(call)`. */
function fakeGoogle(answer = () => new Response(JSON.stringify(imageAnswer()), { status: 200 })) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return answer(calls[calls.length - 1]);
  };
  return { calls, fetchImpl };
}

let n = 0;
async function start(options) {
  const lines = [];
  const skinCacheDir = path.join(scratch, `skins-${n++}`);
  const server = createAppServer({ log: (l) => lines.push(l), cacheDir: path.join(scratch, `voice-${n}`), skinCacheDir, ...options });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { base: `http://127.0.0.1:${port}`, port, lines, skinCacheDir };
}

const post = (base, body) => fetch(`${base}/api/skin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** GET with the path exactly as written: fetch() would normalise '..' away before sending. */
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the prompt wraps the description; the cache key is a 64-hex sha256 of version, model, ratio and prompt', () => {
  const p = skinPrompt('a swirling purple galaxy nebula');
  assert.equal(p, 'A seamless, tileable texture swatch of a swirling purple galaxy nebula. Flat and evenly lit, seen straight on, filling the whole square edge to edge. No objects, no shadows, no text, no logos, no border.');
  const k = skinCacheKey(SKIN_MODELS.fast, p);
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.notEqual(k, skinCacheKey(SKIN_MODELS.high, p), 'Lite and Pro images are cached apart');
});

test('magic bytes and sizes: jpeg, png and webp headers are read; a mislabelled file is refused', () => {
  assert.equal(sniffImage(JPEG), 'image/jpeg');
  assert.deepEqual(imageSize(JPEG, 'image/jpeg'), { width: 1024, height: 1024 });
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(0x0d0a1a0a, 4);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  assert.equal(sniffImage(png), 'image/png');
  assert.deepEqual(imageSize(png, 'image/png'), { width: 640, height: 480 });
  assert.equal(sniffImage(Buffer.from('not an image at all')), null);
  assert.throws(() => pickImage(imageAnswer(png, 'image/jpeg')), (e) => e.status === 502 && /not the jpeg, png or webp it claimed/.test(e.message));
  assert.throws(() => pickImage(imageAnswer(JPEG, 'image/gif')), (e) => e.status === 502);
  // The last non-thought image part wins; a thought image is skipped.
  const thought = tinyJpeg(8, 8);
  const answer = { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: JPEG.toString('base64') } }, { thought: true, inlineData: { mimeType: 'image/jpeg', data: thought.toString('base64') } }] }, finishReason: 'STOP' }] };
  assert.deepEqual(imageSize(pickImage(answer).bytes, 'image/jpeg'), { width: 1024, height: 1024 });
});

test('a miss then a hit: one upstream call, the key only in a header, the file served by its hash, health counts the call', async () => {
  const google = fakeGoogle();
  const { base, port, lines, skinCacheDir } = await start({ config: FAKE_KEYS, fetchImpl: google.fetchImpl });
  const first = await post(base, { text: '  a swirling   purple galaxy nebula ' });
  assert.equal(first.status, 200);
  const a = await first.json();
  assert.equal(a.source, 'nano-banana');
  assert.equal(a.model, 'gemini-3.1-flash-lite-image');
  assert.equal(a.cache, 'miss');
  assert.equal(a.mime, 'image/jpeg');
  assert.equal(a.width, 1024);
  assert.equal(a.height, 1024);
  assert.equal(a.bytes, JPEG.length);
  assert.match(a.url, /^\/api\/skin\/[0-9a-f]{64}\.jpg$/);
  assert.equal(typeof a.latency_ms, 'number');
  assert.equal(google.calls.length, 1);
  const call = google.calls[0];
  assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-image:generateContent');
  assert.equal(call.init.headers['x-goog-api-key'], 'test-gemini-value');
  assert.ok(!call.url.includes('test-gemini-value'), 'the key is never in the URL');
  assert.ok(!call.init.body.includes('test-gemini-value'), 'the key is never in the body');
  assert.equal(call.body.contents[0].parts[0].text, skinPrompt('swirling purple galaxy nebula'), 'spaces collapsed and the article dropped, then wrapped by the server');
  assert.deepEqual(call.body.generationConfig, { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1' } }, 'Lite gets no imageSize');

  const second = await post(base, { text: 'a swirling purple galaxy nebula' });
  const b = await second.json();
  assert.equal(b.cache, 'hit');
  assert.equal(b.url, a.url);
  assert.equal(b.width, 1024);
  assert.equal(google.calls.length, 1, 'a hit makes no upstream call');

  const file = await fetch(`${base}${a.url}`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/jpeg');
  assert.match(file.headers.get('cache-control'), /immutable/);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), JPEG);
  assert.ok(readdirSync(skinCacheDir).some((f) => f.endsWith('.jpg')));

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.skin, 'configured');
  assert.equal(health.models.skin, 'gemini-3.1-flash-lite-image');
  assert.equal(health.models.skin_high, 'gemini-3-pro-image');
  assert.equal(health.limits.image_calls_today, 1, 'the hit was free');
  assert.equal(health.limits.image_units_today, 1);
  assert.equal(health.limits.image_units_per_day, 100);
  const everything = JSON.stringify([a, b, health, lines]);
  assert.ok(!everything.includes('test-gemini-value'), 'the key never comes back or reaches the log');
  assert.ok(!everything.includes('SIGSIG'), 'thoughtSignature is never forwarded or logged');
  assert.ok(lines.some((l) => l.startsWith('POST /api/skin 200')));
});

test('the skin text is normalised before the prompt and the cache key: case, spaces, one article, end punctuation', () => {
  assert.equal(normaliseSkinText('A Swirling purple galaxy nebula.'), 'swirling purple galaxy nebula');
  assert.equal(normaliseSkinText('  the   Brushed GOLD!! '), 'brushed gold');
  assert.equal(normaliseSkinText('an oak wood grain?'), 'oak wood grain');
  assert.equal(normaliseSkinText('a a cat'), 'a cat', 'only one leading article is dropped');
  assert.equal(normaliseSkinText('an'), 'an', 'a lone word is kept');
  assert.equal(normaliseSkinText('brushed gold, with fine scratches'), 'brushed gold, with fine scratches', 'inner punctuation stays');
});

test('"A Swirling purple galaxy nebula." and "swirling purple galaxy nebula" make ONE upstream call', async () => {
  const google = fakeGoogle();
  const { base } = await start({ config: FAKE_KEYS, fetchImpl: google.fetchImpl });
  const a = await (await post(base, { text: 'A Swirling purple galaxy nebula.', quality: 'high' })).json();
  const b = await (await post(base, { text: 'swirling purple galaxy nebula', quality: 'high' })).json();
  assert.equal(google.calls.length, 1, 'the second spelling is a cache hit');
  assert.deepEqual([a.cache, b.cache], ['miss', 'hit']);
  assert.equal(a.url, b.url);
  assert.equal(google.calls[0].body.contents[0].parts[0].text, skinPrompt('swirling purple galaxy nebula'));
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.limits.image_units_today, 4, 'one Pro image paid, not two');
});

test('identical calls in flight share one upstream request and one unit of the cap', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const google = fakeGoogle(async () => {
    await gate;
    return new Response(JSON.stringify(imageAnswer()), { status: 200 });
  });
  const { base } = await start({ config: FAKE_KEYS, fetchImpl: google.fetchImpl });
  const p1 = post(base, { text: 'carbon fibre' });
  const p2 = post(base, { text: 'carbon fibre' });
  await new Promise((r) => setTimeout(r, 150));
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  const [j1, j2] = [await r1.json(), await r2.json()];
  assert.equal(google.calls.length, 1);
  assert.deepEqual([j1.cache, j2.cache].sort(), ['hit', 'miss']);
  assert.equal(j1.url, j2.url);
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.limits.image_units_today, 1);
});

test('high quality uses Nano Banana Pro at 1K and costs 4 units', async () => {
  const google = fakeGoogle();
  const { base } = await start({ config: FAKE_KEYS, fetchImpl: google.fetchImpl });
  const j = await (await post(base, { text: 'brushed gold with fine scratches', quality: 'high' })).json();
  assert.equal(j.model, 'gemini-3-pro-image');
  assert.equal(j.cache, 'miss');
  assert.equal(google.calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent');
  assert.deepEqual(google.calls[0].body.generationConfig.imageConfig, { aspectRatio: '1:1', imageSize: '1K' });
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.limits.image_units_today, 4);
  assert.equal(health.limits.image_calls_today, 1);
  assert.equal((await post(base, { text: 'gold', quality: 'ultra' })).status, 400);
});

test('every error is plain text naming the fallback: 503, 429, 400, 413, 502 (402, 403, bad file), 504, 422', async () => {
  const noKey = await start({ config: NO_KEYS });
  const r503 = await post(noKey.base, { text: 'gold' });
  assert.equal(r503.status, 503);
  assert.match(r503.headers.get('content-type'), /text\/plain/);
  assert.match(await r503.text(), /not configured.*procedural skin instead/);
  const health = await (await fetch(`${noKey.base}/api/health`)).json();
  assert.equal(health.skin, 'missing');

  const google = fakeGoogle();
  const capped = await start({ config: FAKE_KEYS, fetchImpl: google.fetchImpl, limits: createLimits({ imagePerDay: 3 }) });
  assert.equal((await post(capped.base, { text: 'wood' })).status, 200);
  assert.equal((await post(capped.base, { text: 'wood' })).status, 200, 'a hit is free even near the cap');
  const r429 = await post(capped.base, { text: 'marble', quality: 'high' });
  assert.equal(r429.status, 429, 'Pro needs 4 units and only 2 are left');
  assert.match(await r429.text(), /image cap is used up.*procedural skin instead/);
  assert.equal(google.calls.length, 1, 'a capped call never reaches Google');
  assert.equal((await post(capped.base, { text: 'x'.repeat(201) })).status, 400);
  assert.equal((await post(capped.base, { text: '   ' })).status, 400);
  const big = await fetch(`${capped.base}/api/skin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'gold', pad: 'p'.repeat(5000) }) });
  assert.equal(big.status, 413);

  for (const status of [402, 403, 500]) {
    const g = fakeGoogle(() => new Response('{"error":{}}', { status }));
    const s = await start({ config: FAKE_KEYS, fetchImpl: g.fetchImpl });
    const r = await post(s.base, { text: 'lava' });
    assert.equal(r.status, 502, `upstream ${status}`);
    const text = await r.text();
    assert.match(text, new RegExp(`HTTP ${status}.*procedural skin instead`));
    assert.equal(g.calls.length, 1, 'one attempt, no retry');
    assert.ok(!existsSync(s.skinCacheDir) || readdirSync(s.skinCacheDir).length === 0, 'nothing cached on failure');
  }

  const slow = fakeGoogle(() => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  });
  const s504 = await start({ config: FAKE_KEYS, fetchImpl: slow.fetchImpl });
  const r504 = await post(s504.base, { text: 'chrome' });
  assert.equal(r504.status, 504);
  assert.match(await r504.text(), /took over 30 s.*procedural skin instead/);
  assert.equal(slow.calls.length, 1);

  const answers = [
    { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } },
    { candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] },
    { candidates: [{ finishReason: 'NO_IMAGE', content: { parts: [{ text: 'I cannot' }] } }] },
  ];
  for (const answer of answers) {
    const g = fakeGoogle(() => new Response(JSON.stringify(answer), { status: 200 }));
    const s = await start({ config: FAKE_KEYS, fetchImpl: g.fetchImpl });
    const r = await post(s.base, { text: 'a logo' });
    assert.equal(r.status, 422, JSON.stringify(answer));
    assert.match(await r.text(), /Nano Banana (refused|did not draw).*procedural skin instead/);
  }

  const notImage = fakeGoogle(() => new Response(JSON.stringify(imageAnswer(Buffer.from('plain text pretending'), 'image/jpeg')), { status: 200 }));
  const sBad = await start({ config: FAKE_KEYS, fetchImpl: notImage.fetchImpl });
  assert.equal((await post(sBad.base, { text: 'rust' })).status, 502);
  const noPart = fakeGoogle(() => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'here you go' }] } }] }), { status: 200 }));
  const sNone = await start({ config: FAKE_KEYS, fetchImpl: noPart.fetchImpl });
  assert.equal((await post(sNone.base, { text: 'rust' })).status, 502);
});

test('the file route is a strict 64-hex name: traversal, other names and unknown hashes get 404', async () => {
  const google = fakeGoogle();
  const { base, port } = await start({ config: FAKE_KEYS, fetchImpl: google.fetchImpl });
  const made = await (await post(base, { text: 'camouflage' })).json();
  const hash = made.url.slice('/api/skin/'.length, -'.jpg'.length);
  for (const p of [
    '/api/skin/../.env',
    '/api/skin/..%2f..%2fweb%2f.env',
    '/api/skin/../../web/.env',
    `/api/skin/${hash}.jpg/../../.env`,
    `/api/skin/${hash.toUpperCase()}.jpg`,
    `/api/skin/${hash}.json`,
    `/api/skin/${hash}.JPG`,
    `/api/skin/${hash.slice(1)}.jpg`,
    '/api/skin/',
  ]) {
    const r = await rawGet(port, p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.body.includes('GEMINI'), p);
  }
  assert.equal((await rawGet(port, `/api/skin/${'0'.repeat(64)}.jpg`)).status, 404, 'a hash that was never drawn');
  assert.equal((await rawGet(port, `/api/skin/${hash}.png`)).status, 404, 'right hash, wrong type');
  assert.equal((await rawGet(port, made.url)).status, 200);
  const notFound = await rawGet(port, '/nope');
  assert.match(notFound.body, /POST \/api\/skin/);
});
