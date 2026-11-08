// Procedural skins: a seamless, seeded RGBA texture from a few words, with no network. Keyword
// recipes (gold, chrome, brushed metal, carbon fibre, camouflage, wood, marble, galaxy, lava,
// checker, racing stripes, rust) plus the colour words in the text; anything else is coloured
// noise. Every field is periodic over the square (lattice noise that wraps, whole numbers of
// rings and stripes), so the left edge continues the right one and the top the bottom. Same
// text, same bytes. Pure: no DOM, so Node tests cover it and time it.

import { createRng, hashText, type Rng } from './rng';

export type Rgb = [number, number, number];

export interface ProceduralSkin {
  /** size * size * 4 bytes, rows top to bottom, alpha 255. */
  rgba: Uint8ClampedArray;
  size: number;
  /** The recipe and colour words it used, e.g. ['galaxy', 'purple']. */
  matched: string[];
  recipe: RecipeId;
}

export type RecipeId = 'gold' | 'chrome' | 'brushed' | 'carbon' | 'camo' | 'wood' | 'marble' | 'galaxy' | 'lava' | 'checker' | 'stripes' | 'rust' | 'noise';

/** First match wins, so "brushed gold" is gold and "red racing stripes" is stripes. */
const RECIPES: readonly [RecipeId, RegExp][] = [
  ['carbon', /\bcarbon\b|\bcarbon[- ]?fib(re|er)\b/],
  ['camo', /\bcamo(uflage|flage)?\b/],
  ['galaxy', /\bgalax(y|ies)\b|\bnebula\b|\bcosmic\b|\bstarry\b|\bouter space\b|\bstars\b/],
  ['lava', /\blava\b|\bmagma\b|\bmolten\b/],
  ['marble', /\bmarble\b|\bgranite\b/],
  ['wood', /\bwood(en)?\b|\boak\b|\bwalnut\b|\bmahogany\b|\btimber\b|\bplanks?\b|\bpine\b/],
  ['checker', /\bcheck(er|ers|ered|erboard)?\b|\bchequer(ed)?\b/],
  ['stripes', /\bstripe[sd]?\b|\bstriped\b/],
  ['rust', /\brust(y|ed)?\b|\bcorroded\b/],
  ['gold', /\bgold(en)?\b|\bbrass\b/],
  ['chrome', /\bchrome\b|\bmirror\b|\bpolished\b|\bsilver\b/],
  ['brushed', /\bbrushed\b|\bsteel\b|\balumin(i)?um\b|\bmetal(lic)?\b|\btitanium\b/],
];

const COLOURS: Readonly<Record<string, Rgb>> = {
  red: [200, 30, 35],
  crimson: [170, 20, 45],
  orange: [240, 120, 20],
  yellow: [245, 205, 40],
  green: [40, 150, 60],
  lime: [140, 220, 40],
  olive: [100, 110, 50],
  teal: [20, 130, 130],
  cyan: [40, 200, 220],
  blue: [35, 80, 210],
  navy: [20, 30, 90],
  purple: [120, 40, 170],
  violet: [140, 70, 210],
  magenta: [210, 40, 160],
  pink: [240, 130, 180],
  white: [240, 240, 240],
  black: [22, 22, 24],
  grey: [128, 128, 132],
  gray: [128, 128, 132],
  silver: [192, 194, 200],
  gold: [212, 175, 55],
  brown: [110, 70, 40],
  beige: [215, 195, 160],
  maroon: [110, 20, 30],
};

/** The colour words in a line, in order, without repeats (grey and gray count once). */
export function colourWords(text: string): string[] {
  const out: string[] = [];
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const w = word === 'gray' ? 'grey' : word;
    if (COLOURS[w] && !out.includes(w)) out.push(w);
  }
  return out;
}

export function recipeFor(text: string): RecipeId {
  const t = text.toLowerCase();
  for (const [id, re] of RECIPES) if (re.test(t)) return id;
  return 'noise';
}

/**
 * How a skin's surface takes the light, read from the words. A picture alone only sets colour:
 * gold, chrome or brushed steel read as metal through metalness, a reflection and fine bumps that
 * catch the light. Matte looks keep a dull surface. The FIRST material word decides: "a galaxy
 * nebula with tiny gold stars" and "rusty metal" are matte, "brushed gold with fine scratches" is metal.
 */
export interface SkinFinish {
  kind: 'metal' | 'matte';
  metalness: number;
  roughness: number;
  /** Bump strength from the picture's brightness: scratches and grain catch the light. 0 for none. */
  bump: number;
}

const METAL_WORDS = /\b(gold(en)?|chrome|chromed|silver|steel|metal(lic)?|brass|bronze|copper|alumin(i)?um|titanium|iron|platinum|foil|mirror)\b/;
const MATTE_WORDS = /\b(rust(y|ed)?|wood(en)?|matte|stone|marble|camo(uflage)?|carbon|fabric|cloth|leather|rubber|lava|galaxy|nebula)\b/;

export function finishFor(text: string): SkinFinish {
  const t = text.toLowerCase();
  const metal = METAL_WORDS.exec(t);
  const matte = MATTE_WORDS.exec(t);
  // The first material word decides; the word "matte" itself always wins.
  if (!metal || /\bmatte\b/.test(t) || (matte !== null && matte.index < metal.index)) return { kind: 'matte', metalness: 0, roughness: 0.6, bump: 0 };
  const polished = /\b(polished|mirror|shiny|chrome|chromed|glossy)\b/.test(t);
  const brushed = /\b(brushed|scratch(es|ed)?|worn|satin|scuffed)\b/.test(t);
  return {
    kind: 'metal',
    metalness: 0.9,
    roughness: polished && !brushed ? 0.22 : brushed ? 0.42 : 0.32,
    bump: brushed ? 1 : 0.4,
  };
}

/** The words a preset chip or a recipe stands for, for tests and the status line. */
export const RECIPE_WORDS: Readonly<Record<RecipeId, string>> = {
  gold: 'gold',
  chrome: 'chrome',
  brushed: 'brushed metal',
  carbon: 'carbon fibre',
  camo: 'camouflage',
  wood: 'wood',
  marble: 'marble',
  galaxy: 'galaxy',
  lava: 'lava',
  checker: 'checker',
  stripes: 'racing stripes',
  rust: 'rust',
  noise: 'coloured noise',
};

// ---- Periodic fields ---------------------------------------------------------------------

/**
 * Value noise on a cellsX x cellsY lattice that wraps, sampled at size x size, added into `out`
 * with weight `amp`. Smoothstep between lattice points. Lattice sides must divide nothing: the
 * wrap comes from indexing the lattice modulo its side.
 */
function addNoise(out: Float32Array, size: number, cellsX: number, cellsY: number, amp: number, rng: Rng): void {
  const lattice = new Float32Array(cellsX * cellsY);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng();
  const ix0 = new Int32Array(size);
  const ix1 = new Int32Array(size);
  const sx = new Float32Array(size);
  for (let x = 0; x < size; x++) {
    const f = (x * cellsX) / size;
    const i = Math.floor(f);
    const t = f - i;
    ix0[x] = i % cellsX;
    ix1[x] = (i + 1) % cellsX;
    sx[x] = t * t * (3 - 2 * t);
  }
  for (let y = 0; y < size; y++) {
    const f = (y * cellsY) / size;
    const j = Math.floor(f);
    const t = f - j;
    const sy = t * t * (3 - 2 * t);
    const r0 = (j % cellsY) * cellsX;
    const r1 = ((j + 1) % cellsY) * cellsX;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const a = lattice[r0 + ix0[x]!]!;
      const b = lattice[r0 + ix1[x]!]!;
      const c = lattice[r1 + ix0[x]!]!;
      const d = lattice[r1 + ix1[x]!]!;
      const s = sx[x]!;
      const top = a + (b - a) * s;
      const bottom = c + (d - c) * s;
      out[row + x] = out[row + x]! + amp * (top + (bottom - top) * sy);
    }
  }
}

/** Fractal noise in [0, 1]: octaves of wrapping value noise, each twice as fine and half as strong. */
function fbm(size: number, cells: number, octaves: number, rng: Rng, stretchX = 1, stretchY = 1): Float32Array {
  // Above 256 px the field is drawn at half size and doubled: its finest lattice cell is still
  // several pixels wide, so nothing is lost, and the octaves cost a quarter as much.
  const work = size > 256 && size % 2 === 0 ? size / 2 : size;
  const out = new Float32Array(work * work);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const c = cells << o;
    if (c > size) break;
    addNoise(out, work, Math.max(1, c * stretchX), Math.max(1, c * stretchY), amp, rng);
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / total;
  return work === size ? out : double(out, work);
}

/** Bilinear 2x upsampling that wraps at the edges, so a seamless field stays seamless. */
function double(src: Float32Array, n: number): Float32Array {
  const size = n * 2;
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const y0 = y >> 1;
    const r0 = y0 * n;
    const r1 = ((y0 + 1) % n) * n;
    const odd = y & 1;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const x0 = x >> 1;
      const x1 = (x0 + 1) % n;
      const a = src[r0 + x0]!;
      const top = x & 1 ? (a + src[r0 + x1]!) * 0.5 : a;
      if (!odd) out[row + x] = top;
      else {
        const c = src[r1 + x0]!;
        const bottom = x & 1 ? (c + src[r1 + x1]!) * 0.5 : c;
        out[row + x] = (top + bottom) * 0.5;
      }
    }
  }
  return out;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function shade(c: Rgb, k: number): Rgb {
  return [c[0] * k, c[1] * k, c[2] * k];
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Writes a two-colour ramp: colour = lerp(dark, light, field). Fast path used by most recipes. */
function ramp(rgba: Uint8ClampedArray, field: Float32Array, dark: Rgb, light: Rgb): void {
  const [r0, g0, b0] = dark;
  const dr = light[0] - r0;
  const dg = light[1] - g0;
  const db = light[2] - b0;
  for (let i = 0, p = 0; i < field.length; i++, p += 4) {
    const t = field[i]!;
    rgba[p] = r0 + dr * t;
    rgba[p + 1] = g0 + dg * t;
    rgba[p + 2] = b0 + db * t;
    rgba[p + 3] = 255;
  }
}

/** Stretches a field to use the whole 0..1 range, so recipes do not come out flat. */
function normalise(field: Float32Array): void {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < field.length; i++) {
    const v = field[i]!;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const k = hi - lo > 1e-6 ? 1 / (hi - lo) : 0;
  for (let i = 0; i < field.length; i++) field[i] = (field[i]! - lo) * k;
}

// ---- Recipes -------------------------------------------------------------------------------

type Recipe = (rgba: Uint8ClampedArray, size: number, rng: Rng, colours: Rgb[]) => void;

/** Brushed streaks along x: long in x, fine in y, plus a soft large-scale sheen. */
function streaks(size: number, rng: Rng): Float32Array {
  const fine = fbm(size, 8, 3, rng, 0.25, 16);
  const sheen = fbm(size, 2, 2, rng);
  for (let i = 0; i < fine.length; i++) fine[i] = 0.55 * fine[i]! + 0.45 * sheen[i]!;
  normalise(fine);
  return fine;
}

function scratches(rgba: Uint8ClampedArray, size: number, rng: Rng, count: number, bright: number): void {
  // Short straight scratches that wrap around the edges, so they stay seamless.
  for (let s = 0; s < count; s++) {
    let x = rng() * size;
    let y = rng() * size;
    const angle = (rng() - 0.5) * 0.5;
    const len = 20 + rng() * 120;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    for (let k = 0; k < len; k++) {
      const px = ((Math.floor(x) % size) + size) % size;
      const py = ((Math.floor(y) % size) + size) % size;
      const p = (py * size + px) * 4;
      rgba[p] = rgba[p]! + bright;
      rgba[p + 1] = rgba[p + 1]! + bright;
      rgba[p + 2] = rgba[p + 2]! + bright * 0.8;
      x += dx;
      y += dy;
    }
  }
}

const recipes: Readonly<Record<RecipeId, Recipe>> = {
  gold(rgba, size, rng, colours) {
    const tint = colours.find((c) => c !== COLOURS.gold);
    const base: Rgb = tint ? mix(COLOURS.gold!, tint, 0.35) : [212, 172, 60];
    ramp(rgba, streaks(size, rng), shade(base, 0.62), mix(base, [255, 240, 170], 0.55));
    scratches(rgba, size, rng, 220, 26);
  },
  chrome(rgba, size, rng, colours) {
    const f = fbm(size, 2, 3, rng);
    const s = fbm(size, 8, 2, rng, 0.25, 16);
    // Hard bands like a reflected horizon: chrome reads as contrast, not as grey.
    for (let i = 0; i < f.length; i++) f[i] = 0.8 * smooth(0.35, 0.65, f[i]!) + 0.2 * s[i]!;
    const tint = colours[0] && colours[0] !== COLOURS.silver ? colours[0] : null;
    const dark: Rgb = tint ? shade(tint, 0.35) : [52, 58, 70];
    const light: Rgb = tint ? mix(tint, [255, 255, 255], 0.75) : [238, 242, 250];
    ramp(rgba, f, dark, light);
  },
  brushed(rgba, size, rng, colours) {
    const base = colours[0] ?? ([168, 172, 178] as Rgb);
    ramp(rgba, streaks(size, rng), shade(base, 0.68), mix(base, [245, 247, 250], 0.45));
    scratches(rgba, size, rng, 160, 20);
  },
  carbon(rgba, size, rng, colours) {
    // A 2x2 twill: 32 tows across the square, each cell a tow running across or along.
    const tows = 32;
    const cell = size / tows;
    const tint = colours[0] ?? ([60, 64, 72] as Rgb);
    const fine = fbm(size, 64, 1, rng);
    for (let y = 0; y < size; y++) {
      const cy = Math.floor(y / cell);
      const fy = (y - cy * cell) / cell;
      for (let x = 0; x < size; x++) {
        const cx = Math.floor(x / cell);
        const fx = (x - cx * cell) / cell;
        const across = (cx + cy) % 4 < 2;
        const t = across ? fy : fx;
        // A tow is bright along its middle and dark at its edges; the other direction is duller.
        const ridge = Math.sin(Math.PI * t);
        const k = (across ? 0.55 + 0.45 * ridge : 0.3 + 0.35 * ridge) * (0.85 + 0.3 * fine[y * size + x]!);
        const p = (y * size + x) * 4;
        rgba[p] = 10 + tint[0] * k;
        rgba[p + 1] = 10 + tint[1] * k;
        rgba[p + 2] = 12 + tint[2] * k;
        rgba[p + 3] = 255;
      }
    }
  },
  camo(rgba, size, rng, colours) {
    const palette: Rgb[] = colours.length >= 2 ? colours.slice(0, 4) : [[86, 98, 58], [128, 116, 74], [58, 50, 36], [34, 40, 30]];
    if (colours.length === 1) for (let i = 0; i < palette.length; i++) palette[i] = mix(palette[i]!, colours[0]!, 0.45);
    const f = fbm(size, 4, 4, rng);
    const g = fbm(size, 4, 4, rng);
    normalise(f);
    normalise(g);
    for (let i = 0, p = 0; i < f.length; i++, p += 4) {
      const v = f[i]!;
      const w = g[i]!;
      const c = v > 0.62 ? palette[2 % palette.length]! : w > 0.6 ? palette[1 % palette.length]! : v < 0.3 ? palette[3 % palette.length]! : palette[0]!;
      rgba[p] = c[0];
      rgba[p + 1] = c[1];
      rgba[p + 2] = c[2];
      rgba[p + 3] = 255;
    }
  },
  wood(rgba, size, rng, colours) {
    const warp = fbm(size, 2, 3, rng, 1, 1);
    const grain = fbm(size, 8, 2, rng, 0.25, 8);
    const light = colours[0] ?? ([196, 146, 92] as Rgb);
    const dark = colours[1] ?? shade(light, 0.58);
    const rings = 9;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        // A whole number of rings down the square, bent by wrapping noise: seamless both ways.
        const r = ((y * rings) / size + 2.2 * warp[i]!) % 1;
        const ring = smooth(0.0, 0.25, r) * (1 - smooth(0.6, 1.0, r));
        const t = 0.25 + 0.55 * ring + 0.2 * grain[i]!;
        const p = i * 4;
        rgba[p] = dark[0] + (light[0] - dark[0]) * t;
        rgba[p + 1] = dark[1] + (light[1] - dark[1]) * t;
        rgba[p + 2] = dark[2] + (light[2] - dark[2]) * t;
        rgba[p + 3] = 255;
      }
    }
  },
  marble(rgba, size, rng, colours) {
    const turb = fbm(size, 3, 5, rng);
    const base = colours[0] ?? ([236, 234, 228] as Rgb);
    const vein = colours[1] ?? ([92, 94, 104] as Rgb);
    const waves = 3;
    const step = (2 * Math.PI * waves) / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const tv = turb[i]!;
        const s = Math.sin((x + y) * step + 6 * Math.PI * tv);
        const q = 1 - (s < 0 ? -s : s);
        const q2 = q * q;
        const t = q2 * q2 * q2 * q; // q^7: thin, sharp veins
        const k = 1 - 0.1 * tv;
        const p = i * 4;
        rgba[p] = base[0] * k + (vein[0] - base[0] * k) * t;
        rgba[p + 1] = base[1] * k + (vein[1] - base[1] * k) * t;
        rgba[p + 2] = base[2] * k + (vein[2] - base[2] * k) * t;
        rgba[p + 3] = 255;
      }
    }
  },
  galaxy(rgba, size, rng, colours) {
    const a = fbm(size, 2, 5, rng);
    const b = fbm(size, 3, 4, rng);
    normalise(a);
    normalise(b);
    const c1 = colours[0] ?? ([120, 40, 190] as Rgb);
    const c2 = colours[1] ?? ([30, 90, 200] as Rgb);
    const deep: Rgb = [6, 4, 18];
    for (let i = 0, p = 0; i < a.length; i++, p += 4) {
      const av = a[i]!;
      const bv = b[i]!;
      const cloud = smooth(0.35, 0.95, av) * 0.9;
      const glow = smooth(0.8, 1, av * bv * 1.6) * 90;
      for (let ch = 0; ch < 3; ch++) {
        const neb = c1[ch]! + (c2[ch]! - c1[ch]!) * bv;
        rgba[p + ch] = deep[ch]! + (neb - deep[ch]!) * cloud + (ch === 1 ? glow * 0.7 : glow);
      }
      rgba[p + 3] = 255;
    }
    // Stars: single bright pixels with a soft cross on the brightest few, wrapped at the edges.
    const stars = Math.round((size * size) / 900);
    for (let s = 0; s < stars; s++) {
      const x = Math.floor(rng() * size);
      const y = Math.floor(rng() * size);
      const v = 150 + rng() * 105;
      const big = rng() < 0.08;
      for (const [ox, oy, k] of big ? [[0, 0, 1], [1, 0, 0.5], [-1, 0, 0.5], [0, 1, 0.5], [0, -1, 0.5]] : [[0, 0, 1]]) {
        const p = ((((y + oy!) % size) + size) % size) * size * 4 + ((((x + ox!) % size) + size) % size) * 4;
        rgba[p] = Math.max(rgba[p]!, v * k!);
        rgba[p + 1] = Math.max(rgba[p + 1]!, v * k!);
        rgba[p + 2] = Math.max(rgba[p + 2]!, v * k! + 10);
      }
    }
  },
  lava(rgba, size, rng, colours) {
    const f = fbm(size, 4, 5, rng);
    normalise(f);
    const hot = colours[0] ?? ([255, 110, 20] as Rgb);
    for (let i = 0, p = 0; i < f.length; i++, p += 4) {
      // Ridged noise: bright where the field crosses its middle, like glowing cracks in a crust.
      const ridge = 1 - Math.abs(2 * f[i]! - 1);
      const heat = smooth(0.78, 0.98, ridge);
      const core = smooth(0.93, 1, ridge);
      const crust = 18 + 30 * f[i]!;
      rgba[p] = crust + (hot[0] - crust) * heat + 40 * core;
      rgba[p + 1] = crust * 0.45 + hot[1] * heat + 150 * core;
      rgba[p + 2] = crust * 0.3 + hot[2] * heat + 60 * core;
      rgba[p + 3] = 255;
    }
  },
  checker(rgba, size, rng, colours) {
    const a = colours[0] ?? ([236, 236, 236] as Rgb);
    const b = colours[1] ?? (colours[0] ? ([22, 22, 24] as Rgb) : ([24, 24, 26] as Rgb));
    const checks = 8;
    const cell = size / checks;
    const n = fbm(size, 16, 1, rng);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const c = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? a : b;
        const k = 0.94 + 0.06 * n[y * size + x]!;
        const p = (y * size + x) * 4;
        rgba[p] = c[0] * k;
        rgba[p + 1] = c[1] * k;
        rgba[p + 2] = c[2] * k;
        rgba[p + 3] = 255;
      }
    }
  },
  stripes(rgba, size, rng, colours) {
    const base = colours[0] ?? ([30, 70, 200] as Rgb);
    const stripe = colours[1] ?? (colours[0] === COLOURS.white ? ([22, 22, 24] as Rgb) : ([240, 240, 240] as Rgb));
    const n = fbm(size, 4, 2, rng);
    // Two bands either side of the middle, running the length of the object (along v).
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const inStripe = (u > 0.36 && u < 0.45) || (u > 0.55 && u < 0.64);
        const c = inStripe ? stripe : base;
        const k = 0.92 + 0.12 * n[y * size + x]!;
        const p = (y * size + x) * 4;
        rgba[p] = c[0] * k;
        rgba[p + 1] = c[1] * k;
        rgba[p + 2] = c[2] * k;
        rgba[p + 3] = 255;
      }
    }
  },
  rust(rgba, size, rng, colours) {
    const f = fbm(size, 4, 5, rng);
    const g = fbm(size, 32, 2, rng);
    normalise(f);
    const metal = colours[0] ?? ([112, 104, 98] as Rgb);
    const rust1: Rgb = [150, 64, 24];
    const rust2: Rgb = [92, 40, 18];
    for (let i = 0, p = 0; i < f.length; i++, p += 4) {
      const t = smooth(0.3, 0.55, f[i]!);
      const gv = g[i]!;
      const k = 0.85 + 0.3 * gv;
      for (let ch = 0; ch < 3; ch++) {
        const r = rust1[ch]! + (rust2[ch]! - rust1[ch]!) * gv;
        rgba[p + ch] = (metal[ch]! + (r - metal[ch]!) * t) * k;
      }
      rgba[p + 3] = 255;
    }
  },
  noise(rgba, size, rng, colours) {
    const hue = rng();
    const a = colours[0] ?? hsl(hue, 0.55, 0.45);
    const b = colours[1] ?? mix(a, hsl((hue + 0.12) % 1, 0.6, 0.7), 0.6);
    const f = fbm(size, 4, 5, rng);
    normalise(f);
    ramp(rgba, f, shade(a, 0.75), b);
  },
};

function hsl(h: number, s: number, l: number): Rgb {
  const f = (n: number): number => {
    const k = (n + h * 12) % 12;
    return 255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}

/** A seamless skin for these words. Same text, same bytes. */
export function proceduralSkin(text: string, size = 1024): ProceduralSkin {
  const clean = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const recipe = recipeFor(clean);
  const words = colourWords(clean).filter((w) => !(recipe === 'gold' && w === 'gold') && !(recipe === 'chrome' && w === 'silver'));
  const colours = words.map((w) => COLOURS[w]!);
  const rgba = new Uint8ClampedArray(size * size * 4);
  recipes[recipe](rgba, size, createRng(hashText(`skin|${clean}`)), colours);
  return { rgba, size, matched: [RECIPE_WORDS[recipe], ...words], recipe };
}
