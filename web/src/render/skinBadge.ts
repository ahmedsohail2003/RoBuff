// The skin badge says where the skin ON the object came from, part by part, not what the key
// server could do. A procedural fallback after a failed Nano Banana call is never shown as live,
// and the badge names the model that really drew the image (Lite or Pro). Pure: no imports.

export const SKIN_MODEL_FAST = 'gemini-3.1-flash-lite-image';
export const SKIN_MODEL_HIGH = 'gemini-3-pro-image';
export const SKIN_MODEL_NAMES: Readonly<Record<string, string>> = {
  [SKIN_MODEL_FAST]: 'Nano Banana 2 Lite',
  [SKIN_MODEL_HIGH]: 'Nano Banana Pro',
};

/** "37 ms" under a second (so a fast procedural draw never reads "0.0 s"), else "3.4 s". */
export function duration(ms: number): string {
  return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function modelName(model: string | null): string {
  return model ? (SKIN_MODEL_NAMES[model] ?? model) : 'procedural';
}

/** What the badge needs to know about one part's skin. */
export interface BadgePart {
  source: 'nano-banana' | 'procedural' | 'upload' | null;
  model: string | null;
  /** True when a procedural skin was drawn because Nano Banana failed or timed out. */
  fallback?: boolean;
  /** True when the Nano Banana image came from the key server's disk cache or this page's session cache: no new image was paid for. */
  cached?: boolean;
}

export type BadgeKind = 'live' | 'offline' | 'fallback' | 'upload' | 'ready' | 'mixed';

export interface Badge {
  text: string;
  /** data-testid: skin-source-<kind>. */
  kind: BadgeKind;
  /** True only when every skinned part was drawn by Nano Banana. */
  live: boolean;
}

/**
 * The badge for the object in the slot. `live` is whether Nano Banana could be asked now; it only
 * matters while no part has a skin yet.
 */
export function skinBadge(parts: readonly BadgePart[], live: boolean): Badge {
  const labels: string[] = [];
  const kinds = new Set<BadgeKind>();
  const add = (label: string, kind: BadgeKind): void => {
    if (!labels.includes(label)) labels.push(label);
    kinds.add(kind);
  };
  for (const p of parts) {
    // Still a real Nano Banana image (kind 'live'), but a repeat says (cached), not (live).
    if (p.source === 'nano-banana') add(`${modelName(p.model)} (${p.cached ? 'cached' : 'live'})`, 'live');
    else if (p.source === 'upload') add('your image', 'upload');
    else if (p.source === 'procedural') {
      if (p.fallback) add('procedural (Nano Banana failed)', 'fallback');
      else add('procedural (offline)', 'offline');
    }
  }
  if (labels.length === 0) {
    return live ? { text: 'skin: none yet, Nano Banana ready', kind: 'ready', live: false } : { text: 'skin: procedural (offline)', kind: 'offline', live: false };
  }
  const kind: BadgeKind = kinds.size === 1 ? [...kinds][0]! : 'mixed';
  return { text: `skin: ${labels.join(' + ')}`, kind, live: kind === 'live' };
}

/**
 * The words a skin is cached by in this page: lowercase, spaces collapsed, trailing punctuation
 * and one leading article (a, an, the) dropped. The key server's normaliseSkinText (server/skin.mjs)
 * does the same before its prompt and disk cache key, so voice ("paint it like galaxy") and typing
 * ("a galaxy.") share one paid image.
 */
export function normaliseSkinText(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.,;:!?\u2026]+$/u, '')
    .replace(/^(a|an|the)\s+/, '')
    .trim();
}

/** What each quality choice costs and how long it takes, as measured live (Pro 12-15 s, Lite about 4 s). */
export const SKIN_QUALITY_INFO = {
  high: { name: 'Nano Banana Pro', seconds: 13, cents: 14 },
  fast: { name: 'Nano Banana 2 Lite', seconds: 4, cents: 3 },
} as const;
