// Where a skin image comes from. Nano Banana through the key server when /api/health says the
// skin route is configured; otherwise (or when a call fails or times out) a procedural skin drawn
// in the browser, with a note saying why. An uploaded image is decoded in the browser and never
// sent anywhere. Offline makes no network call at all. Every result is a 1024 x 1024 canvas.

import { objectBrain } from '../objects/objectBrain';
import { proceduralSkin } from '../objects/skinPattern';
import type { SkinImage } from './objectSkin';
import { normaliseSkinText, SKIN_MODEL_FAST, SKIN_MODEL_HIGH } from './skinBadge';

export { modelName, normaliseSkinText, SKIN_MODEL_FAST, SKIN_MODEL_HIGH, SKIN_MODEL_NAMES, SKIN_QUALITY_INFO } from './skinBadge';
export const SKIN_SIZE = 1024;
export const UPLOAD_MAX_BYTES = 15 * 1024 * 1024;
const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
/** The key server waits 30 s (fast) or 60 s (Pro) for Google; the browser waits 2 s more, so the server's own plain answer arrives first. */
const BROWSER_TIMEOUT_MS = { fast: 32_000, high: 62_000 } as const;
const SESSION_CACHE = 8;

export type SkinQuality = 'fast' | 'high';
/** Ahmed, 02:10: High quality (Nano Banana Pro) is the default; Fast (Lite) is the other choice. */
export const DEFAULT_SKIN_QUALITY: SkinQuality = 'high';

/** One logged skin request, for the live check. */
export interface SkinCall {
  text: string;
  quality: SkinQuality;
  source: SkinImage['source'];
  ok: boolean;
  status: number | null;
  model: string | null;
  cache: SkinImage['cache'];
  width: number | null;
  height: number | null;
  /** Browser-side time, ms. */
  ms: number;
  /** Nano Banana's own time as the key server measured it, ms. */
  drawnMs: number | null;
  error: string | null;
}

function newCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = SKIN_SIZE;
  canvas.height = SKIN_SIZE;
  return canvas;
}

/** Draws a bitmap into a fresh 1024 x 1024 canvas, cropping the middle square (cover), then frees the bitmap. */
function coverCrop(bitmap: ImageBitmap): HTMLCanvasElement {
  const canvas = newCanvas();
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('this browser has no 2D canvas');
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, SKIN_SIZE, SKIN_SIZE);
  bitmap.close();
  return canvas;
}

export class SkinBrain {
  readonly calls: SkinCall[] = [];
  private readonly session = new Map<string, SkinImage>();

  /** Nano Banana is used when the object brain is live and the key server has the skin route. */
  get live(): boolean {
    return objectBrain.live && objectBrain.health.skin === 'configured';
  }

  model(quality: SkinQuality = DEFAULT_SKIN_QUALITY): string {
    return quality === 'high' ? (objectBrain.health.skinModelHigh ?? SKIN_MODEL_HIGH) : (objectBrain.health.skinModel ?? SKIN_MODEL_FAST);
  }

  /** A skin for these words: Nano Banana when live, else procedural. Never throws for a bad network. */
  async draw(text: string, quality: SkinQuality = DEFAULT_SKIN_QUALITY): Promise<SkinImage> {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    const live = this.live;
    // The same rules as the key server's cache key, so "a galaxy." and "galaxy" are one image.
    const key = `${live ? quality : 'procedural'}|${normaliseSkinText(clean)}`;
    const kept = this.session.get(key);
    if (kept) {
      // Refresh its place, so the cache drops the least recently used.
      this.session.delete(key);
      this.session.set(key, kept);
      this.log({ text: clean, quality, source: kept.source, ok: true, status: null, model: kept.model, cache: 'session', width: kept.canvas.width, height: kept.canvas.height, ms: 0, drawnMs: kept.drawnMs, error: null });
      return { ...kept, cache: 'session', ms: 0 };
    }
    let image: SkinImage;
    if (!live) image = this.procedural(clean, null);
    else {
      try {
        image = await this.nanoBanana(clean, quality);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        image = this.procedural(clean, `${why.replace(/[.\s]+$/, '')}. So this skin is procedural, drawn in the browser.`);
      }
    }
    this.remember(key, image);
    return image;
  }

  /** A procedural skin, drawn in the browser in about 0.1 s. */
  procedural(text: string, note: string | null): SkinImage {
    const t0 = performance.now();
    const skin = proceduralSkin(text, SKIN_SIZE);
    const canvas = newCanvas();
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('this browser has no 2D canvas');
    ctx.putImageData(new ImageData(skin.rgba as Uint8ClampedArray<ArrayBuffer>, SKIN_SIZE, SKIN_SIZE), 0, 0);
    const ms = performance.now() - t0;
    if (note === null) this.log({ text, quality: 'fast', source: 'procedural', ok: true, status: null, model: null, cache: null, width: SKIN_SIZE, height: SKIN_SIZE, ms, drawnMs: null, error: null });
    return { text, source: 'procedural', model: null, canvas, ms, drawnMs: null, cache: null, note };
  }

  /** The operator's own picture: png, jpeg or webp up to 15 MB. Decoded here; it never leaves the browser. */
  async fromFile(file: File): Promise<SkinImage> {
    const t0 = performance.now();
    if (!UPLOAD_TYPES.includes(file.type)) throw new Error(`That file is ${file.type || 'of an unknown type'}. Use a PNG, JPEG or WebP image.`);
    if (file.size > UPLOAD_MAX_BYTES) throw new Error(`That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 15 MB.`);
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error('That image could not be decoded.');
    }
    const canvas = coverCrop(bitmap);
    const ms = performance.now() - t0;
    this.log({ text: file.name, quality: 'fast', source: 'upload', ok: true, status: null, model: null, cache: null, width: SKIN_SIZE, height: SKIN_SIZE, ms, drawnMs: null, error: null });
    return { text: file.name || 'your image', source: 'upload', model: null, canvas, ms, drawnMs: null, cache: null, note: null };
  }

  /** One attempt through the key server. Throws a plain message on any failure; draw() falls back. */
  private async nanoBanana(text: string, quality: SkinQuality): Promise<SkinImage> {
    const t0 = performance.now();
    const call: SkinCall = { text, quality, source: 'nano-banana', ok: false, status: null, model: this.model(quality), cache: null, width: null, height: null, ms: 0, drawnMs: null, error: null };
    this.log(call);
    try {
      const signal = AbortSignal.timeout(BROWSER_TIMEOUT_MS[quality]);
      const res = await fetch('/api/skin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, quality }), signal });
      call.status = res.status;
      if (!res.ok) {
        const message = (await res.text()).trim().slice(0, 240);
        throw new Error(message || `Nano Banana answered HTTP ${res.status}`);
      }
      const body = (await res.json()) as Record<string, unknown>;
      const url = typeof body.url === 'string' && /^\/api\/skin\/[0-9a-f]{64}\.(jpg|png|webp)$/.test(body.url) ? body.url : null;
      if (!url) throw new Error('The key server sent no image address');
      call.model = typeof body.model === 'string' ? body.model : call.model;
      call.cache = body.cache === 'hit' ? 'hit' : 'miss';
      call.drawnMs = typeof body.drawn_ms === 'number' ? body.drawn_ms : null;
      call.width = typeof body.width === 'number' ? body.width : null;
      call.height = typeof body.height === 'number' ? body.height : null;
      const file = await fetch(url, { signal });
      if (!file.ok) throw new Error(`The key server could not send the image (HTTP ${file.status})`);
      const bitmap = await createImageBitmap(await file.blob());
      const canvas = coverCrop(bitmap);
      call.ok = true;
      call.ms = performance.now() - t0;
      return { text, source: 'nano-banana', model: call.model, canvas, ms: call.ms, drawnMs: call.drawnMs, cache: call.cache, note: null };
    } catch (error) {
      call.ms = performance.now() - t0;
      const timedOut = error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
      call.error = timedOut ? `Nano Banana took over ${BROWSER_TIMEOUT_MS[quality] / 1000} s` : error instanceof Error ? error.message : String(error);
      throw new Error(call.error);
    }
  }

  private remember(key: string, image: SkinImage): void {
    this.session.set(key, image);
    while (this.session.size > SESSION_CACHE) this.session.delete(this.session.keys().next().value!);
  }

  private log(call: SkinCall): void {
    this.calls.push(call);
    if (this.calls.length > 50) this.calls.shift();
  }
}

/** The page's one skin brain. */
export const skinBrain = new SkinBrain();
