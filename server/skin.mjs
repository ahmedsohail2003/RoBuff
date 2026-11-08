// Nano Banana skins for spawned objects: the key server draws a seamless texture swatch with a
// Gemini image model, caches it on disk by a content hash, and serves the file back by that hash.
//   POST /api/skin { text (<= 200 chars), quality?: 'fast'|'high' }
//        -> { source: 'nano-banana', model, cache: 'hit'|'miss', url, mime, width, height, bytes, latency_ms, drawn_ms }
//   GET  /api/skin/<64 hex>.(jpg|png|webp) -> the cached image
// The browser sends only a short description: the server writes the prompt around it. Each call is
// paid (about 3.4 cents on Nano Banana 2 Lite, 13.8 on Pro), so: one attempt and no retry, the cache
// is checked before the daily cap, and identical calls in flight share one upstream request.
// The key goes only in the x-goog-api-key header. thoughtSignature is never logged or forwarded.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const SKIN_MODELS = Object.freeze({ fast: 'gemini-3.1-flash-lite-image', high: 'gemini-3-pro-image' });
export const SKIN_MODEL_NAMES = Object.freeze({ fast: 'Nano Banana 2 Lite', high: 'Nano Banana Pro' });
/** Units taken from the daily image cap: Pro costs four times as much as Lite. */
export const SKIN_UNITS = Object.freeze({ fast: 1, high: 4 });
export const SKIN_TIMEOUT_MS = Object.freeze({ fast: 30_000, high: 60_000 });
export const SKIN_MAX_CHARS = 200;
const BODY_MAX_BYTES = 4096;
const CACHE_VERSION = 'skin-v1';
/** Image finish reasons that mean the model chose not to draw. */
const REFUSED_FINISH = new Set(['IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_OTHER', 'IMAGE_RECITATION', 'NO_IMAGE', 'SAFETY', 'PROHIBITED_CONTENT', 'RECITATION']);
const EXT = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' });
const MIME = Object.freeze({ jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' });
export const SKIN_FILE_ROUTE = /^\/api\/skin\/([0-9a-f]{64})\.(jpg|png|webp)$/;
const FALLBACK = 'so the app paints a procedural skin instead';

/** The only prompt the image model ever sees. The description is the operator's words. */
export function skinPrompt(description) {
  return `A seamless, tileable texture swatch of ${description}. Flat and evenly lit, seen straight on, filling the whole square edge to edge. No objects, no shadows, no text, no logos, no border.`;
}

export function skinCacheKey(model, prompt) {
  return createHash('sha256').update(`${CACHE_VERSION}|${model}|1:1|${prompt}`).digest('hex');
}

class SkinError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The mime type the bytes really are, or null. The upstream label is checked against this. */
export function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Pixel size from the file header, or null when the header is not one we read. */
export function imageSize(buf, mime) {
  try {
    if (mime === 'image/png' && buf.length >= 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        const len = buf.readUInt16BE(i + 2);
        // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        i += 2 + len;
      }
      return null;
    }
    if (mime === 'image/webp' && buf.length >= 30) {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** The image in a generateContent answer: the last inlineData part that is not a thought. Throws SkinError. */
export function pickImage(data) {
  const blocked = data?.promptFeedback?.blockReason;
  if (blocked) throw new SkinError(422, `Nano Banana refused that description (${String(blocked)}), ${FALLBACK}.`);
  const candidate = data?.candidates?.[0];
  const finish = typeof candidate?.finishReason === 'string' ? candidate.finishReason : '';
  if (REFUSED_FINISH.has(finish)) throw new SkinError(422, `Nano Banana did not draw that description (${finish}), ${FALLBACK}.`);
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  let found = null;
  for (const part of parts) {
    if (part && part.thought !== true && part.inlineData && typeof part.inlineData.data === 'string') found = part.inlineData;
  }
  if (!found) throw new SkinError(502, `Nano Banana sent no image${finish ? ` (finish ${finish})` : ''}, ${FALLBACK}.`);
  const bytes = Buffer.from(found.data, 'base64');
  const real = sniffImage(bytes);
  const said = typeof found.mimeType === 'string' ? found.mimeType.toLowerCase() : '';
  if (!real || !EXT[said] || real !== said) throw new SkinError(502, `Nano Banana sent a file that is not the jpeg, png or webp it claimed, ${FALLBACK}.`);
  return { bytes, mime: real };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_MAX_BYTES) throw new SkinError(413, `The request body is over ${BODY_MAX_BYTES} bytes.`);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new SkinError(400, 'The request body is not JSON.');
  }
}

function sendText(res, status, message) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(message);
}

/**
 * @param {{ config: { geminiKey: string }, limits: { allowRequest(ip: string): boolean, takeImage(units: number): boolean },
 *   fetchImpl?: typeof fetch, cacheDir?: string }} options
 */
export function createSkinRoutes(options) {
  const { config, limits } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const cacheDir = options.cacheDir ?? path.join(HERE, '..', 'web', '.skin-cache');
  /** key -> promise of the drawn entry, so identical calls in flight share one upstream request */
  const inFlight = new Map();
  /** key -> bytes, only if the disk write failed, so the url still answers in this process */
  const memory = new Map();
  const status = config.geminiKey ? 'configured' : 'missing';

  function fileFor(key, ext) {
    // key is 64 hex chars from our own hash or the strict route regex; ext comes from a fixed table.
    return path.join(cacheDir, `${key}.${ext}`);
  }

  function readCached(key) {
    for (const ext of ['jpg', 'png', 'webp']) {
      const file = fileFor(key, ext);
      if (!existsSync(file)) continue;
      let meta = {};
      try {
        meta = JSON.parse(readFileSync(path.join(cacheDir, `${key}.json`), 'utf8'));
      } catch {
        meta = {};
      }
      const bytes = readFileSync(file);
      const mime = MIME[ext];
      const size = imageSize(bytes, mime) ?? { width: null, height: null };
      return { key, ext, mime, width: size.width, height: size.height, bytes: bytes.length, drawn_ms: meta.drawn_ms ?? null };
    }
    const mem = memory.get(key);
    return mem ? { ...mem.entry } : null;
  }

  async function draw(key, model, quality, prompt) {
    const t0 = performance.now();
    const generationConfig = { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1' } };
    if (quality === 'high') generationConfig.imageConfig.imageSize = '1K';
    let res;
    try {
      res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': config.geminiKey },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig }),
        signal: AbortSignal.timeout(SKIN_TIMEOUT_MS[quality]),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new SkinError(504, `Nano Banana took over ${SKIN_TIMEOUT_MS[quality] / 1000} s, ${FALLBACK}.`);
      }
      throw new SkinError(502, `Nano Banana could not be reached, ${FALLBACK}.`);
    }
    if (!res.ok) {
      const why = res.status === 402 || res.status === 403 ? ' (billing or access)' : res.status === 429 ? ' (Google rate limit)' : '';
      throw new SkinError(502, `Nano Banana answered HTTP ${res.status}${why}, ${FALLBACK}.`);
    }
    let data;
    try {
      data = await res.json();
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new SkinError(504, `Nano Banana took over ${SKIN_TIMEOUT_MS[quality] / 1000} s, ${FALLBACK}.`);
      throw new SkinError(502, `Nano Banana sent an answer that is not JSON, ${FALLBACK}.`);
    }
    const { bytes, mime } = pickImage(data);
    data = null; // drop the multi-megabyte answer (and its thoughtSignature) as soon as possible
    const drawn_ms = Math.round(performance.now() - t0);
    const ext = EXT[mime];
    const size = imageSize(bytes, mime) ?? { width: null, height: null };
    const entry = { key, ext, mime, width: size.width, height: size.height, bytes: bytes.length, drawn_ms };
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(fileFor(key, ext), bytes);
      writeFileSync(path.join(cacheDir, `${key}.json`), JSON.stringify({ model, mime, width: size.width, height: size.height, bytes: bytes.length, drawn_ms, created: new Date().toISOString() }));
    } catch {
      memory.set(key, { entry, bytes });
      if (memory.size > 12) memory.delete(memory.keys().next().value);
    }
    return entry;
  }

  async function post(req, res) {
    const t0 = performance.now();
    if (status === 'missing') throw new SkinError(503, `Nano Banana is not configured on this server (no GEMINI_API_KEY), ${FALLBACK}.`);
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (!limits.allowRequest(ip)) throw new SkinError(429, 'Too many requests: the limit is 30 a minute. Try again shortly.');
    const body = await readJson(req);
    const raw = typeof body?.text === 'string' ? body.text : '';
    // Control characters out, spaces collapsed: the description is a few plain words.
    const text = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) throw new SkinError(400, 'Send JSON with a non-empty "text" describing the skin.');
    if (text.length > SKIN_MAX_CHARS) throw new SkinError(400, `"text" is ${text.length} characters; the limit is ${SKIN_MAX_CHARS}.`);
    const quality = body?.quality === undefined || body?.quality === null ? 'fast' : body.quality;
    if (quality !== 'fast' && quality !== 'high') throw new SkinError(400, '"quality" is "fast" or "high".');
    const model = SKIN_MODELS[quality];
    const prompt = skinPrompt(text);
    const key = skinCacheKey(model, prompt);

    let entry = readCached(key);
    let cache = 'hit';
    if (!entry) {
      let pending = inFlight.get(key);
      if (!pending) {
        if (!limits.takeImage(SKIN_UNITS[quality])) throw new SkinError(429, `Today's Nano Banana image cap is used up, ${FALLBACK} until midnight.`);
        pending = draw(key, model, quality, prompt).finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
        cache = 'miss';
      }
      entry = await pending;
    }
    const json = {
      source: 'nano-banana',
      model,
      quality,
      cache,
      url: `/api/skin/${entry.key}.${entry.ext}`,
      mime: entry.mime,
      width: entry.width,
      height: entry.height,
      bytes: entry.bytes,
      latency_ms: Math.round(performance.now() - t0),
      drawn_ms: entry.drawn_ms,
    };
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(json));
  }

  function get(res, route) {
    const m = SKIN_FILE_ROUTE.exec(route);
    if (!m) throw new SkinError(404, 'Not found. Skin files are /api/skin/<64 hex>.jpg, .png or .webp.');
    const [, key, ext] = m;
    const file = fileFor(key, ext);
    let bytes = null;
    if (existsSync(file)) bytes = readFileSync(file);
    else if (memory.get(key)?.entry.ext === ext) bytes = memory.get(key).bytes;
    if (!bytes) throw new SkinError(404, 'That skin is not in the cache.');
    // The name is a content hash, so the file never changes.
    res.writeHead(200, { 'content-type': MIME[ext], 'content-length': bytes.length, 'cache-control': 'public, max-age=31536000, immutable' });
    res.end(bytes);
  }

  return {
    /** 'configured' or 'missing', for /api/health */
    status,
    models: { skin: SKIN_MODELS.fast, skin_high: SKIN_MODELS.high },
    /** True for the routes this module answers. Any other /api/skin path falls through to the 404. */
    handles(method, route) {
      return (method === 'POST' && route === '/api/skin') || (method === 'GET' && SKIN_FILE_ROUTE.test(route));
    },
    /** Answers the request itself and never throws. */
    async handle(req, res, route) {
      try {
        if (req.method === 'POST') await post(req, res);
        else get(res, route);
      } catch (error) {
        const code = error instanceof SkinError ? error.status : 500;
        const message = error instanceof SkinError ? error.message : `The key server hit an error drawing the skin, ${FALLBACK}.`;
        if (!res.headersSent) sendText(res, code, message);
        else res.destroy();
      }
    },
  };
}
