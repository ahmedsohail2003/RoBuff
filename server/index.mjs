// The key server: the only place the Gemini and ElevenLabs keys live. The browser never sees
// them. Routes:
//   GET  /api/health  -> { ok, gemini: 'configured'|'missing', elevenlabs: 'configured'|'missing', ... }
//   POST /api/spec    { text }  -> Gemini structured output: { source, model, intent, gravity, spec, latency_ms }
//   POST /api/tts     { text (<= 160 chars), fixed? } -> ElevenLabs mp3 stream; fixed lines cached on disk
// Keys come from web/.env (or the process environment). Their values are never logged or sent back.
// Run: node server/index.mjs   (port 8787 on 127.0.0.1; PORT and HOST override)

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createLimits, isAllowedOrigin } from './limits.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GEMINI_MODEL = 'gemini-3.8-flash';
export const TTS_MODEL = 'eleven_flash_v2_5';
export const TTS_MAX_CHARS = 160;
export const SPEC_MAX_CHARS = 300;
const BODY_MAX_BYTES = 4096;
const UPSTREAM_TIMEOUT_MS = 10_000;

export const COMMAND_SCHEMA = JSON.parse(readFileSync(path.join(HERE, 'commandSchema.json'), 'utf8'));
const SPEC_FIELDS = ['kind', 'width_mm', 'height_mm', 'roughness', 'lumpiness', 'seed', 'material', 'color', 'why'];

const SYSTEM_PROMPT = [
  'You read one line typed or spoken by the operator of a simulated robot arm and answer with JSON only.',
  'intent spawn: the operator wants an object made. Describe it with the object fields. Quote the size they asked for, even if it is far too big: a validator rescales or refuses it, not you.',
  'intent set_gravity: they want Earth, Mars, Moon, Bennu or orbit gravity; put it in gravity.',
  'intent home: send the arm to its home pose. intent help: they ask what they can say. intent none: anything else.',
  'You can never stop or resume the arm; the browser handles stop itself. For any intent but spawn, fill the object fields with any valid values.',
  'why is one short plain sentence.',
].join(' ');

/** KEY=VALUE lines; # comments; optional quotes. Values are returned, never printed. */
export function readEnvFile(file) {
  const out = {};
  if (!file || !existsSync(file)) return out;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/** The process environment wins over the file, so a deployment can set keys without a file. */
export function loadConfig(envFile = process.env.AFTERGRIP_ENV_FILE ?? path.join(HERE, '..', 'web', '.env')) {
  const file = readEnvFile(envFile);
  const pick = (name) => (process.env[name] ?? file[name] ?? '').trim();
  return {
    geminiKey: pick('GEMINI_API_KEY'),
    elevenKey: pick('ELEVENLABS_API_KEY'),
    voiceId: pick('ELEVENLABS_VOICE_ID'),
    allowedOrigins: pick('ALLOWED_ORIGINS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendText(res, status, message) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(message);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_MAX_BYTES) throw new HttpError(413, `The request body is over ${BODY_MAX_BYTES} bytes.`);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'The request body is not JSON.');
  }
}

function requestText(body, max) {
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) throw new HttpError(400, 'Send JSON with a non-empty "text".');
  if (text.length > max) throw new HttpError(400, `"text" is ${text.length} characters; the limit is ${max}.`);
  return text;
}

/** JSON Schema for responseJsonSchema: everything but propertyOrdering, which is Gemini's own keyword. */
function jsonSchemaVariant(schema) {
  const { propertyOrdering: _ordering, ...rest } = schema;
  void _ordering;
  return rest;
}

/** The older responseSchema field takes OpenAPI-style upper-case type names. */
function openApiVariant(node) {
  if (Array.isArray(node)) return node.map(openApiVariant);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) out[key] = key === 'type' && typeof value === 'string' ? value.toUpperCase() : openApiVariant(value);
  return out;
}

/** One Gemini structured-output call. Returns the parsed JSON object. */
async function askGemini(key, text, fetchImpl) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const call = (generationConfig) =>
    fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig,
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  let res = await call({ responseMimeType: 'application/json', responseJsonSchema: jsonSchemaVariant(COMMAND_SCHEMA), temperature: 0.4 });
  // Not run live yet (no key today): if this model rejects responseJsonSchema, try the older field once.
  if (res.status === 400) res = await call({ responseMimeType: 'application/json', responseSchema: openApiVariant(COMMAND_SCHEMA), temperature: 0.4 });
  if (!res.ok) throw new HttpError(502, `Gemini answered HTTP ${res.status}, so the app falls back to its offline mock.`);
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const out = parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
  try {
    return JSON.parse(out);
  } catch {
    throw new HttpError(502, 'Gemini did not return JSON, so the app falls back to its offline mock.');
  }
}

/**
 * @param {{ config?: ReturnType<typeof loadConfig>, limits?: ReturnType<typeof createLimits>, fetchImpl?: typeof fetch,
 *   cacheDir?: string, log?: (line: string) => void }} [options]
 */
export function createAppServer(options = {}) {
  const config = options.config ?? loadConfig();
  const limits = options.limits ?? createLimits();
  const fetchImpl = options.fetchImpl ?? fetch;
  const cacheDir = options.cacheDir ?? path.join(HERE, '..', 'web', '.voice-cache');
  const log = options.log ?? ((line) => console.log(line));
  const gemini = config.geminiKey ? 'configured' : 'missing';
  const elevenlabs = config.elevenKey && config.voiceId ? 'configured' : 'missing';

  function health() {
    const body = { ok: true, server: 'aftergrip key server', gemini, elevenlabs, models: { spec: GEMINI_MODEL, tts: TTS_MODEL }, limits: limits.snapshot() };
    if (config.elevenKey && !config.voiceId) body.elevenlabs_note = 'ELEVENLABS_API_KEY is set but ELEVENLABS_VOICE_ID is not.';
    return body;
  }

  async function spec(req, res) {
    if (gemini === 'missing') throw new HttpError(503, 'Gemini is not configured on this server (no GEMINI_API_KEY), so the app uses its offline mock.');
    const text = requestText(await readJsonBody(req), SPEC_MAX_CHARS);
    if (!limits.takeSpec()) throw new HttpError(429, "Today's Gemini cap is used up, so the app uses its offline mock until midnight.");
    const t0 = performance.now();
    const raw = await askGemini(config.geminiKey, text, fetchImpl);
    const latency_ms = Math.round(performance.now() - t0);
    const intent = ['spawn', 'set_gravity', 'home', 'help', 'none'].includes(raw?.intent) ? raw.intent : 'none';
    const gravity = ['earth', 'mars', 'moon', 'bennu', 'orbit'].includes(raw?.gravity) ? raw.gravity : null;
    const objectSpec = intent === 'spawn' ? Object.fromEntries(SPEC_FIELDS.map((k) => [k, raw?.[k]])) : null;
    sendJson(res, 200, { source: 'gemini', model: GEMINI_MODEL, intent, gravity, spec: objectSpec, latency_ms });
  }

  async function tts(req, res) {
    if (elevenlabs === 'missing') throw new HttpError(503, 'ElevenLabs is not configured on this server (no ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID), so the app uses the browser voice.');
    const body = await readJsonBody(req);
    const text = requestText(body, TTS_MAX_CHARS);
    const fixed = body.fixed === true;
    const file = path.join(cacheDir, `${createHash('sha256').update(`${config.voiceId}|${TTS_MODEL}|${text}`).digest('hex')}.mp3`);
    if (fixed && existsSync(file)) {
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'x-voice-cache': 'hit', 'cache-control': 'no-store' });
      res.end(readFileSync(file));
      return;
    }
    if (!limits.takeTts(text.length)) throw new HttpError(429, "Today's ElevenLabs character cap is used up, so the app uses the browser voice until midnight.");
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.voiceId)}/stream?output_format=mp3_44100_128`;
    const upstream = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'audio/mpeg', 'xi-api-key': config.elevenKey },
      body: JSON.stringify({ text, model_id: TTS_MODEL }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!upstream.ok || !upstream.body) throw new HttpError(502, `ElevenLabs answered HTTP ${upstream.status}, so the app uses the browser voice.`);
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'x-voice-cache': fixed ? 'miss' : 'off', 'cache-control': 'no-store' });
    const chunks = [];
    const stream = Readable.fromWeb(upstream.body);
    stream.on('data', (chunk) => {
      if (fixed) chunks.push(chunk);
    });
    stream.on('end', () => {
      if (!fixed) return;
      try {
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(file, Buffer.concat(chunks));
      } catch {
        // A cache write failure only costs a later call.
      }
    });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  return http.createServer(async (req, res) => {
    const t0 = performance.now();
    const route = (req.url ?? '').split('?')[0];
    // Method, route, status and time only: never bodies, headers or keys.
    res.on('finish', () => log(`${req.method} ${route} ${res.statusCode} ${Math.round(performance.now() - t0)} ms`));
    try {
      if (!isAllowedOrigin(req.headers.origin, config.allowedOrigins)) throw new HttpError(403, 'This origin may not use the key server.');
      if (req.method === 'GET' && route === '/api/health') sendJson(res, 200, health());
      else if (req.method === 'POST' && (route === '/api/spec' || route === '/api/tts')) {
        const ip = req.socket.remoteAddress ?? 'unknown';
        if (!limits.allowRequest(ip)) throw new HttpError(429, 'Too many requests: the limit is 30 a minute. Try again shortly.');
        if (route === '/api/spec') await spec(req, res);
        else await tts(req, res);
      } else throw new HttpError(404, 'Not found. Routes: GET /api/health, POST /api/spec, POST /api/tts.');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error?.name === 'TimeoutError' ? 504 : 500;
      const message = error instanceof HttpError ? error.message : status === 504 ? 'The upstream service timed out.' : 'The key server hit an error.';
      if (!res.headersSent) sendText(res, status, message);
      else res.destroy();
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';
  const server = createAppServer();
  server.listen(port, host, () => {
    const config = loadConfig();
    console.log(
      `aftergrip key server on http://${host}:${port} | gemini ${config.geminiKey ? 'configured' : 'missing'} | elevenlabs ${config.elevenKey && config.voiceId ? 'configured' : 'missing'}`,
    );
  });
}
