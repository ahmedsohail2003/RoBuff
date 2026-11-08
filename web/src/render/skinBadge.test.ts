import { describe, expect, it } from 'vitest';
import { duration, skinBadge, SKIN_MODEL_FAST, SKIN_MODEL_HIGH, type BadgePart } from './skinBadge';

const bare: BadgePart = { source: null, model: null };
const lite: BadgePart = { source: 'nano-banana', model: SKIN_MODEL_FAST };
const pro: BadgePart = { source: 'nano-banana', model: SKIN_MODEL_HIGH };
const offline: BadgePart = { source: 'procedural', model: null, fallback: false };
const fallback: BadgePart = { source: 'procedural', model: null, fallback: true };
const upload: BadgePart = { source: 'upload', model: null };

describe('skin badge: names the skin on the object, never procedural as live', () => {
  it('a procedural fallback while Nano Banana is live is not shown as live (the verifier run: 422 IMAGE_RECITATION on all 6 parts)', () => {
    const b = skinBadge(Array(6).fill(fallback), true);
    expect(b).toEqual({ text: 'skin: procedural (Nano Banana failed)', kind: 'fallback', live: false });
    expect(b.text).not.toContain('live');
  });

  it('names the model that drew the skin: Pro is not called Lite', () => {
    expect(skinBadge(Array(3).fill(pro), true)).toEqual({ text: 'skin: Nano Banana Pro (live)', kind: 'live', live: true });
    expect(skinBadge(Array(3).fill(lite), true)).toEqual({ text: 'skin: Nano Banana 2 Lite (live)', kind: 'live', live: true });
    expect(skinBadge([lite, pro], true).text).toBe('skin: Nano Banana 2 Lite (live) + Nano Banana Pro (live)');
  });

  it('a mix of live and procedural parts is "mixed" and not marked live', () => {
    const b = skinBadge([lite, lite, fallback, bare], true);
    expect(b).toEqual({ text: 'skin: Nano Banana 2 Lite (live) + procedural (Nano Banana failed)', kind: 'mixed', live: false });
  });

  it('offline procedural, the operator image, and no skin yet', () => {
    expect(skinBadge([offline, offline], false)).toEqual({ text: 'skin: procedural (offline)', kind: 'offline', live: false });
    expect(skinBadge([upload], true)).toEqual({ text: 'skin: your image', kind: 'upload', live: false });
    expect(skinBadge([bare, bare], false)).toEqual({ text: 'skin: procedural (offline)', kind: 'offline', live: false });
    // No skin on the object yet: the badge says Nano Banana is ready, and does not claim a live skin.
    expect(skinBadge([bare, bare], true)).toEqual({ text: 'skin: none yet, Nano Banana ready', kind: 'ready', live: false });
    expect(skinBadge([], true).kind).toBe('ready');
  });

  it('times under a second read in ms, never "0.0 s"', () => {
    expect(duration(36.5)).toBe('37 ms');
    expect(duration(0.2)).toBe('1 ms');
    expect(duration(999.4)).toBe('999 ms');
    expect(duration(3444)).toBe('3.4 s');
  });
});
