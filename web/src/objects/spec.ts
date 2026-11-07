// The object request. Every number here is a request; the guardrail decides.

import { MATERIAL_IDS, type MaterialId } from './materials';

export const KINDS = ['asteroid', 'panel', 'dish', 'bus', 'fragment'] as const;
export type ObjectKind = (typeof KINDS)[number];

export interface ObjectSpec {
  kind: ObjectKind;
  width_mm: number;
  height_mm: number;
  roughness: number;
  lumpiness: number;
  seed: number;
  material: MaterialId;
  color: string;
  why: string;
}

/** Wide enough to carry "the size of Texas" (about 1.2e9 mm) to the guardrail, so the refusal can quote it. */
export const SIZE_RANGE_MM = [1, 2e9] as const;
export const SEED_MAX = 2147483647;
export const WHY_MAX_CHARS = 240;

export const DEFAULT_SPEC: Readonly<ObjectSpec> = {
  kind: 'asteroid',
  width_mm: 40,
  height_mm: 34,
  roughness: 0.5,
  lumpiness: 0.5,
  seed: 1,
  material: 'c_type_rock',
  color: '#6b5f55',
  why: '',
};

/** JSON schema written for Gemini structured output. Not yet run against Gemini: this package uses no key. */
export const OBJECT_SPEC_SCHEMA = {
  type: 'object',
  description: 'A request for one object. The sizes are requests: a validator rescales or refuses them.',
  properties: {
    kind: { type: 'string', enum: [...KINDS], description: 'Which generator makes the shape.' },
    width_mm: {
      type: 'number',
      minimum: SIZE_RANGE_MM[0],
      maximum: SIZE_RANGE_MM[1],
      description: 'Requested width across, in millimetres. Quote the size the person asked for, even if huge.',
    },
    height_mm: { type: 'number', minimum: SIZE_RANGE_MM[0], maximum: SIZE_RANGE_MM[1], description: 'Requested height, in millimetres.' },
    roughness: { type: 'number', minimum: 0, maximum: 1, description: 'Small surface detail, 0 smooth to 1 rough.' },
    lumpiness: { type: 'number', minimum: 0, maximum: 1, description: 'Large shape variation, 0 regular to 1 lumpy.' },
    seed: { type: 'integer', minimum: 0, maximum: SEED_MAX, description: 'Random seed. Same seed, same shape.' },
    material: { type: 'string', enum: [...MATERIAL_IDS], description: 'Material. It sets density and friction.' },
    color: { type: 'string', description: 'Display color as #rrggbb.' },
    why: { type: 'string', description: 'One short sentence on why these values fit the request.' },
  },
  required: ['kind', 'width_mm', 'height_mm', 'roughness', 'lumpiness', 'seed', 'material', 'color', 'why'],
  propertyOrdering: ['kind', 'width_mm', 'height_mm', 'roughness', 'lumpiness', 'seed', 'material', 'color', 'why'],
} as const;

export interface NormalizedSpec {
  spec: ObjectSpec;
  /** One plain sentence per field that had to change. */
  clamps: string[];
}

function clampNumber(value: unknown, min: number, max: number, fallback: number, name: string, clamps: string[]): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (Number.isNaN(n)) {
    clamps.push(`${name} was not a number, so I used ${fallback}.`);
    return fallback;
  }
  if (n < min) {
    clamps.push(`${name} was ${n}, below its range, so I used ${min}.`);
    return min;
  }
  if (n > max) {
    clamps.push(`${name} was ${n}, above its range, so I used ${max}.`);
    return max;
  }
  return n;
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T, name: string, clamps: string[]): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  clamps.push(`${name} ${JSON.stringify(value) ?? 'undefined'} is not one I know, so I used ${fallback}.`);
  return fallback;
}

function normalizeColor(value: unknown, clamps: string[]): string {
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(text)) return text;
    if (/^#[0-9a-f]{3}$/.test(text)) return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
  }
  clamps.push(`color was not #rrggbb, so I used ${DEFAULT_SPEC.color}.`);
  return DEFAULT_SPEC.color;
}

/** Turns anything, including bad model output, into a spec that generators can trust. Never throws. */
export function normalizeSpec(raw: unknown): NormalizedSpec {
  const clamps: string[] = [];
  const isObject = typeof raw === 'object' && raw !== null;
  const input = (isObject ? raw : {}) as Record<string, unknown>;
  if (!isObject) clamps.push('The request was not an object, so I used my defaults.');

  const rawSeed = clampNumber(input.seed, 0, SEED_MAX, DEFAULT_SPEC.seed, 'seed', clamps);
  const seed = Math.floor(rawSeed);
  if (seed !== rawSeed) clamps.push(`seed was ${rawSeed}, so I used ${seed}.`);

  const whyRaw = typeof input.why === 'string' ? input.why : '';
  if (whyRaw.length > WHY_MAX_CHARS) clamps.push(`why was over ${WHY_MAX_CHARS} characters, so I cut it.`);

  return {
    spec: {
      kind: pickEnum(input.kind, KINDS, DEFAULT_SPEC.kind, 'kind', clamps),
      width_mm: clampNumber(input.width_mm, SIZE_RANGE_MM[0], SIZE_RANGE_MM[1], DEFAULT_SPEC.width_mm, 'width_mm', clamps),
      height_mm: clampNumber(input.height_mm, SIZE_RANGE_MM[0], SIZE_RANGE_MM[1], DEFAULT_SPEC.height_mm, 'height_mm', clamps),
      roughness: clampNumber(input.roughness, 0, 1, DEFAULT_SPEC.roughness, 'roughness', clamps),
      lumpiness: clampNumber(input.lumpiness, 0, 1, DEFAULT_SPEC.lumpiness, 'lumpiness', clamps),
      seed,
      material: pickEnum(input.material, MATERIAL_IDS, DEFAULT_SPEC.material, 'material', clamps),
      color: normalizeColor(input.color, clamps),
      why: whyRaw.slice(0, WHY_MAX_CHARS),
    },
    clamps,
  };
}
