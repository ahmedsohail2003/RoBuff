// The object request. Every number here is a request; the guardrail decides.

import { MATERIAL_IDS, type MaterialId } from './materials';

export const KINDS = ['asteroid', 'panel', 'dish', 'bus', 'fragment', 'box', 'cylinder', 'sphere', 'cone', 'assembly'] as const;
export type ObjectKind = (typeof KINDS)[number];

/** The primitives an assembly is built from. Each reuses the single-shape generator of the same name. */
export const PART_SHAPES = ['box', 'cylinder', 'sphere', 'cone'] as const;
export type PartShape = (typeof PART_SHAPES)[number];
export const PARTS_MIN = 1;
export const PARTS_MAX = 8;
export const NAME_MAX_CHARS = 40;
export const PART_NAME_MAX_CHARS = 24;
/** A part thinner than this fraction of the whole object is thickened to it, so no part is a sliver MuJoCo cannot weigh. */
export const PART_MIN_FRACTION = 1 / 150;

/**
 * One part of an assembly, in millimetres, in the object's own frame (z up).
 * size_mm: box length, width, height; cylinder diameter, diameter, length along its own z axis;
 * sphere three diameters; cone base diameter, base diameter, height.
 * rot_deg turns the part about x, then y, then z (fixed axes), around its own centre.
 */
export interface PartSpec {
  name: string;
  shape: PartShape;
  size_mm: [number, number, number];
  pos_mm: [number, number, number];
  rot_deg: [number, number, number];
  color: string;
}

export interface ObjectSpec {
  kind: ObjectKind;
  /** Short display name, such as "AK-47". Spoken and shown; it changes no geometry. */
  name?: string;
  width_mm: number;
  /** A box's depth, front to back. Without it a box has a square footprint. */
  depth_mm?: number;
  height_mm: number;
  roughness: number;
  lumpiness: number;
  seed: number;
  material: MaterialId;
  color: string;
  why: string;
  /** Kind assembly only: the parts, 1 to 8, each its own collision hull. */
  parts?: PartSpec[];
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

const VEC3 = (description: string) => ({ type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description }) as const;

/** One part, for Gemini structured output. */
export const PART_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'What the part is, one or two words: stock, barrel, wing, wheel.' },
    shape: { type: 'string', enum: [...PART_SHAPES], description: 'Primitive shape of the part.' },
    size_mm: VEC3('Real-world size in millimetres. box: length (x), width (y), height (z). cylinder: diameter, diameter, length along its axis (z before rotation). sphere: diameters. cone: base diameter, base diameter, height.'),
    pos_mm: VEC3('Centre of the part in the object frame, millimetres, x forward along the length, y across, z up.'),
    rot_deg: VEC3('Rotation in degrees about x, then y, then z. [0, 90, 0] lays a cylinder along x; tilt a box with a small x or y angle.'),
    color: { type: 'string', description: 'Colour of this part as #rrggbb.' },
  },
  required: ['name', 'shape', 'size_mm', 'pos_mm', 'color'],
  propertyOrdering: ['name', 'shape', 'size_mm', 'pos_mm', 'rot_deg', 'color'],
} as const;

/** JSON schema written for Gemini structured output. */
export const OBJECT_SPEC_SCHEMA = {
  type: 'object',
  description: 'A request for one object. The sizes are requests: a validator rescales or refuses them.',
  properties: {
    kind: {
      type: 'string',
      enum: [...KINDS],
      description: 'Which generator makes the shape. assembly is for recognisable things built from parts; box, cylinder, sphere and cone are for simple everyday things; asteroid, panel, dish, bus and fragment are for space things.',
    },
    name: { type: 'string', description: 'Short display name of the thing asked for, such as electric guitar, helicopter or skateboard.' },
    width_mm: {
      type: 'number',
      minimum: SIZE_RANGE_MM[0],
      maximum: SIZE_RANGE_MM[1],
      description: 'Requested width across, in millimetres. Quote the size the person asked for, even if huge.',
    },
    depth_mm: { type: 'number', minimum: SIZE_RANGE_MM[0], maximum: SIZE_RANGE_MM[1], description: 'Kind box only: depth front to back in millimetres, when it differs from the width.' },
    height_mm: { type: 'number', minimum: SIZE_RANGE_MM[0], maximum: SIZE_RANGE_MM[1], description: 'Requested height, in millimetres.' },
    roughness: { type: 'number', minimum: 0, maximum: 1, description: 'Small surface detail, 0 smooth to 1 rough.' },
    lumpiness: { type: 'number', minimum: 0, maximum: 1, description: 'Large shape variation, 0 regular to 1 lumpy.' },
    seed: { type: 'integer', minimum: 0, maximum: SEED_MAX, description: 'Random seed. Same seed, same shape.' },
    material: { type: 'string', enum: [...MATERIAL_IDS], description: 'Material. It sets density and friction.' },
    color: { type: 'string', description: 'Display color as #rrggbb.' },
    parts: {
      type: 'array',
      minItems: PARTS_MIN,
      maxItems: PARTS_MAX,
      items: PART_SCHEMA,
      description: 'Kind assembly only: 3 to 8 coloured parts at real-world proportions in millimetres. A validator rescales the whole object.',
    },
    why: { type: 'string', description: 'One short sentence on why these values fit the request.' },
  },
  required: ['kind', 'name', 'width_mm', 'height_mm', 'roughness', 'lumpiness', 'seed', 'material', 'color', 'why'],
  propertyOrdering: ['kind', 'name', 'width_mm', 'depth_mm', 'height_mm', 'roughness', 'lumpiness', 'seed', 'material', 'color', 'parts', 'why'],
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

function parseColor(value: unknown): string | null {
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(text)) return text;
    if (/^#[0-9a-f]{3}$/.test(text)) return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
  }
  return null;
}

function normalizeColor(value: unknown, clamps: string[]): string {
  const color = parseColor(value);
  if (color) return color;
  clamps.push(`color was not #rrggbb, so I used ${DEFAULT_SPEC.color}.`);
  return DEFAULT_SPEC.color;
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** Three finite numbers, each kept in [min, max]. Null when it is not a list of three numbers. */
function vec3(value: unknown, min: number, max: number): { v: [number, number, number]; clamped: boolean } | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const out: number[] = [];
  let clamped = value.length !== 3;
  for (const raw of value.slice(0, 3)) {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
    if (!Number.isFinite(n)) return null;
    const kept = Math.min(max, Math.max(min, n));
    if (kept !== n) clamped = true;
    out.push(kept);
  }
  return { v: out as [number, number, number], clamped };
}

/** The parts of an assembly, cleaned. Bad parts are dropped with one plain line each; never throws. */
export function normalizeParts(raw: unknown, fallbackColor: string, clamps: string[]): PartSpec[] {
  if (!Array.isArray(raw)) return [];
  if (raw.length > PARTS_MAX) clamps.push(`There were ${raw.length} parts; I keep at most ${PARTS_MAX}, so I used the first ${PARTS_MAX}.`);
  const parts: PartSpec[] = [];
  raw.slice(0, PARTS_MAX).forEach((item, i) => {
    const input = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const name = cleanText(typeof input.name === 'string' ? input.name.replace(/_/g, ' ') : input.name, PART_NAME_MAX_CHARS) || `part ${i + 1}`;
    const size = vec3(input.size_mm, SIZE_RANGE_MM[0] / 10, SIZE_RANGE_MM[1]);
    if (!size) {
      clamps.push(`Part ${name} had no size as three numbers, so I left it out.`);
      return;
    }
    const pos = vec3(input.pos_mm, -SIZE_RANGE_MM[1], SIZE_RANGE_MM[1]) ?? { v: [0, 0, 0] as [number, number, number], clamped: true };
    const rot = input.rot_deg === undefined ? { v: [0, 0, 0] as [number, number, number], clamped: false } : (vec3(input.rot_deg, -360, 360) ?? { v: [0, 0, 0] as [number, number, number], clamped: true });
    if (size.clamped || pos.clamped || rot.clamped) clamps.push(`Part ${name} had a size, place or turn out of range, so I kept it in range.`);
    const shape = (PART_SHAPES as readonly string[]).includes(input.shape as string) ? (input.shape as PartShape) : 'box';
    if (shape !== input.shape) clamps.push(`Part ${name} shape ${JSON.stringify(input.shape) ?? 'undefined'} is not one I know, so I used box.`);
    parts.push({ name, shape, size_mm: size.v, pos_mm: pos.v, rot_deg: rot.v, color: parseColor(input.color) ?? fallbackColor });
  });
  // Thicken slivers: a 0.5 mm wing on a 40 m plane would weigh nothing MuJoCo can use.
  // Half the object's reach from its origin, roughly: the farthest part centre plus that part's largest half-size.
  let reach = 0;
  for (const part of parts) reach = Math.max(reach, Math.max(...part.pos_mm.map(Math.abs)) + Math.max(...part.size_mm) / 2);
  const floor = 2 * reach * PART_MIN_FRACTION;
  let thickened = 0;
  for (const part of parts) {
    if (part.size_mm.some((d) => d < floor)) {
      part.size_mm = part.size_mm.map((d) => Math.max(d, floor)) as [number, number, number];
      thickened++;
    }
  }
  if (thickened > 0) clamps.push(`${thickened === 1 ? 'One part was' : `${thickened} parts were`} thinner than 1/${Math.round(1 / PART_MIN_FRACTION)} of the whole object, so I thickened ${thickened === 1 ? 'it' : 'them'} to ${Number(floor.toPrecision(3))} mm.`);
  return parts;
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

  const spec: ObjectSpec = {
    kind: pickEnum(input.kind, KINDS, DEFAULT_SPEC.kind, 'kind', clamps),
    width_mm: clampNumber(input.width_mm, SIZE_RANGE_MM[0], SIZE_RANGE_MM[1], DEFAULT_SPEC.width_mm, 'width_mm', clamps),
    height_mm: clampNumber(input.height_mm, SIZE_RANGE_MM[0], SIZE_RANGE_MM[1], DEFAULT_SPEC.height_mm, 'height_mm', clamps),
    roughness: clampNumber(input.roughness, 0, 1, DEFAULT_SPEC.roughness, 'roughness', clamps),
    lumpiness: clampNumber(input.lumpiness, 0, 1, DEFAULT_SPEC.lumpiness, 'lumpiness', clamps),
    seed,
    material: pickEnum(input.material, MATERIAL_IDS, DEFAULT_SPEC.material, 'material', clamps),
    color: normalizeColor(input.color, clamps),
    why: whyRaw.slice(0, WHY_MAX_CHARS),
  };
  // Optional fields appear only when given, so a spec without them stays exactly as it was.
  const name = cleanText(input.name, NAME_MAX_CHARS);
  if (name) spec.name = name;
  if (spec.kind === 'box' && input.depth_mm !== undefined && input.depth_mm !== null) {
    spec.depth_mm = clampNumber(input.depth_mm, SIZE_RANGE_MM[0], SIZE_RANGE_MM[1], spec.width_mm, 'depth_mm', clamps);
  }
  if (spec.kind === 'assembly') {
    const parts = normalizeParts(input.parts, spec.color, clamps);
    if (parts.length >= PARTS_MIN) spec.parts = parts;
    else {
      clamps.push('kind assembly came with no usable parts, so I made one box.');
      spec.kind = 'box';
    }
  }
  return { spec, clamps };
}
