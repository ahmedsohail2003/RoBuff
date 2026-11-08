// Offline mock: turns text into a spec with simple keywords, so the demo runs with no key.
// It is not Gemini, and its output says so in the field "source": "offline-mock".

import type { MaterialId } from './materials';
import { hashText } from './rng';
import { normalizeSpec, SEED_MAX, type ObjectKind, type ObjectSpec } from './spec';

export interface MockResult {
  source: 'offline-mock';
  spec: ObjectSpec;
  /** Which keywords decided what. */
  matched: string[];
  clamps: string[];
}

export interface Preset {
  id: string;
  title: string;
  text: string;
  spec: ObjectSpec;
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'bennu-sample',
    title: 'Bennu-like C-type sample',
    text: 'a Bennu-like carbonaceous asteroid sample',
    spec: { kind: 'asteroid', width_mm: 40, height_mm: 33, roughness: 0.6, lumpiness: 0.65, seed: 101955, material: 'c_type_rock', color: '#3b3734', why: 'Dark, crumbly C-type rock like the Bennu return sample, at sample density.' },
  },
  {
    id: 's-type-chip',
    title: 'S-type chip',
    text: 'a small S-type rock chip like Itokawa',
    spec: { kind: 'fragment', width_mm: 30, height_mm: 20, roughness: 0.7, lumpiness: 0.5, seed: 25143, material: 's_type_rock', color: '#8a7b68', why: 'A stony S-type chip, denser than C-type, at sample density.' },
  },
  {
    id: 'cubesat-panel',
    title: 'CubeSat solar panel',
    text: 'a cubesat solar panel',
    spec: { kind: 'panel', width_mm: 50, height_mm: 10, roughness: 0.5, lumpiness: 0.4, seed: 1, material: 'aluminium', color: '#1f3a6e', why: 'A small deployable panel with recessed cells.' },
  },
  {
    id: 'comms-dish',
    title: 'Comms dish',
    text: 'a small communications dish antenna',
    spec: { kind: 'dish', width_mm: 48, height_mm: 20, roughness: 0.4, lumpiness: 0.5, seed: 7, material: 'aluminium', color: '#d8d8d2', why: 'A solid dish on a short foot.' },
  },
  {
    id: 'comet-ice-shard',
    title: 'Comet ice shard',
    text: 'a shard of comet ice',
    spec: { kind: 'fragment', width_mm: 34, height_mm: 30, roughness: 0.8, lumpiness: 0.6, seed: 67, material: 'ice', color: '#cfe6f2', why: 'Slippery ice, so the friction check matters.' },
  },
];

const KIND_WORDS: [RegExp, ObjectKind, string][] = [
  [/\b(needle|spike|rod|boom|mast)\b/, 'fragment', 'needle'],
  [/\b(panel|solar|array)\b/, 'panel', 'panel'],
  [/\b(dish|antenna|reflector)\b/, 'dish', 'dish'],
  [/\b(bus|cubesat|satellite|probe)\b/, 'bus', 'bus'],
  [/\b(fragment|debris|shard|chip|piece|shrapnel)\b/, 'fragment', 'fragment'],
  [/\b(box|cube|block|crate|brick|dice|book|phone)\b/, 'box', 'box'],
  [/\b(soda can|tin can|a can|cylinder|tube|wheel|puck|mug|cup|bottle|jar|battery)\b/, 'cylinder', 'cylinder'],
  [/\b(cone|funnel|pyramid)\b/, 'cone', 'cone'],
  [/\b(ball|sphere|orange|apple|marble|globe|orb)\b/, 'sphere', 'sphere'],
  [/\b(asteroid|rock|boulder|meteorite|bennu|ryugu|itokawa|stone|pebble|sample)\b/, 'asteroid', 'asteroid'],
];

const MATERIAL_WORDS: [RegExp, MaterialId, string][] = [
  [/\b(ice|icy|comet|frozen)\b/, 'ice', 'ice'],
  [/\b(iron|nickel|steel|metallic)\b/, 'iron', 'iron'],
  [/\b(alumin(i)?um|metal)\b/, 'aluminium', 'aluminium'],
  [/\b(s-type|s type|stony|itokawa|chondrite)\b/, 's_type_rock', 's-type'],
  [/\b(c-type|c type|carbonaceous|bennu|ryugu)\b/, 'c_type_rock', 'c-type'],
];

const DEFAULT_MATERIAL: Record<ObjectKind, MaterialId> = {
  asteroid: 'c_type_rock',
  panel: 'aluminium',
  dish: 'aluminium',
  bus: 'aluminium',
  fragment: 'aluminium',
  box: 'aluminium',
  cylinder: 'aluminium',
  sphere: 'aluminium',
  cone: 'aluminium',
};

/** Height as a fraction of width when the text gives only one size. */
const HEIGHT_RATIO: Record<ObjectKind, number> = { asteroid: 0.82, panel: 0.2, dish: 0.42, bus: 0.9, fragment: 0.75, box: 1, cylinder: 1.2, sphere: 1, cone: 1.1 };
const DEFAULT_WIDTH_MM: Record<ObjectKind, number> = { asteroid: 40, panel: 50, dish: 48, bus: 42, fragment: 32, box: 34, cylinder: 34, sphere: 38, cone: 40 };

/** Plain colour words, so "a green block" is green. */
const COLOR_WORDS: [RegExp, string, string][] = [
  [/\b(green|grass)\b/, '#4f9a3a', 'green'],
  [/\b(red)\b/, '#c8362e', 'red'],
  [/\b(blue)\b/, '#2f5fb3', 'blue'],
  [/\b(yellow|tennis)\b/, '#d9e021', 'yellow'],
  [/\b(orange)\b/, '#f08a24', 'orange'],
  [/\b(white)\b/, '#f2f2ee', 'white'],
  [/\b(black)\b/, '#1e1e1e', 'black'],
  [/\b(brown|wood|wooden|dirt)\b/, '#8a5a32', 'brown'],
];

const COLORS: Record<MaterialId, string> = {
  c_type_rock: '#3b3734',
  s_type_rock: '#8a7b68',
  ice: '#cfe6f2',
  aluminium: '#c9ccd1',
  iron: '#5a5550',
};

const UNIT_MM: Record<string, number> = { mm: 1, millimeter: 1, millimetre: 1, cm: 10, centimeter: 10, centimetre: 10, m: 1000, meter: 1000, metre: 1000, km: 1e6, kilometer: 1e6, kilometre: 1e6 };

/** Rough sizes for "the size of ...". Requests only: the guardrail rescales them. Common round figures, not looked up. */
const SIZE_OF: [RegExp, number, string][] = [
  [/size of texas/, 1.2e9, 'size of Texas (about 1,200 km)'],
  [/size of (a )?(house|building)/, 1e4, 'size of a house (about 10 m)'],
  [/size of (a )?(car)/, 4.5e3, 'size of a car (about 4.5 m)'],
  [/size of (a )?(football|soccer) field/, 1e5, 'size of a football field (about 100 m)'],
  [/size of bennu/, 4.9e5, 'size of Bennu (about 490 m)'],
];

function parseSize(text: string): { mm: number; label: string } | null {
  for (const [pattern, mm, label] of SIZE_OF) if (pattern.test(text)) return { mm, label };
  const match = /(\d+(?:\.\d+)?)\s*(mm|cm|km|m|millimet(?:er|re)s?|centimet(?:er|re)s?|kilomet(?:er|re)s?|met(?:er|re)s?)\b/.exec(text);
  if (!match) return null;
  const unit = match[2]!.replace(/s$/, '');
  const factor = UNIT_MM[unit];
  return factor ? { mm: Number(match[1]) * factor, label: `${match[1]} ${match[2]}` } : null;
}

export function specFromText(input: string): MockResult {
  const text = String(input ?? '').toLowerCase();
  const matched: string[] = [];

  const wanted = text.trim();
  const preset = PRESETS.find((p) => p.text.toLowerCase() === wanted || p.id === wanted || p.title.toLowerCase() === wanted);
  if (preset) {
    return { source: 'offline-mock', spec: { ...preset.spec }, matched: [`preset:${preset.id}`], clamps: [] };
  }

  let kind: ObjectKind = 'asteroid';
  let needle = false;
  for (const [pattern, k, word] of KIND_WORDS) {
    if (pattern.test(text)) {
      kind = k;
      needle = word === 'needle';
      matched.push(`kind:${word}`);
      break;
    }
  }
  let material = DEFAULT_MATERIAL[kind];
  for (const [pattern, m, word] of MATERIAL_WORDS) {
    if (pattern.test(text)) {
      material = m;
      matched.push(`material:${word}`);
      break;
    }
  }

  const size = parseSize(text);
  let width = DEFAULT_WIDTH_MM[kind];
  let height = width * HEIGHT_RATIO[kind];
  if (size) {
    matched.push(`size:${size.label}`);
    width = size.mm;
    height = size.mm * HEIGHT_RATIO[kind];
  }
  if (needle) {
    // Thin and tall: the stated size is the length.
    height = size ? size.mm : 300;
    width = height / 1000;
  }

  let roughness = 0.5;
  let lumpiness = 0.5;
  if (/\b(smooth|round|polished)\b/.test(text)) {
    roughness = 0.15;
    lumpiness = 0.2;
    matched.push('shape:smooth');
  }
  if (/\b(rough|jagged|craggy|cratered)\b/.test(text)) {
    roughness = 0.9;
    matched.push('shape:rough');
  }
  if (/\b(lumpy|irregular|potato)\b/.test(text)) {
    lumpiness = 0.9;
    matched.push('shape:lumpy');
  }

  const seedMatch = /\bseed\s*(\d+)\b/.exec(text);
  const seed = seedMatch ? Number(seedMatch[1]) % (SEED_MAX + 1) : hashText(text) % (SEED_MAX + 1);
  const why = `Offline mock, not Gemini: ${matched.length ? `matched ${matched.join(', ')}` : 'no keywords matched, so these are defaults'}.`;
  let color = COLORS[material];
  for (const [pattern, hex, word] of COLOR_WORDS) {
    if (pattern.test(text)) {
      color = hex;
      matched.push(`color:${word}`);
      break;
    }
  }
  const { spec, clamps } = normalizeSpec({ kind, width_mm: width, height_mm: height, roughness, lumpiness, seed, material, color, why });
  return { source: 'offline-mock', spec, matched, clamps };
}
