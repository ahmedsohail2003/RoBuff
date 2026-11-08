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
    if (p.source === 'nano-banana') add(`${modelName(p.model)} (live)`, 'live');
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
