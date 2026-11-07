// Seeded randomness and byte hashing. Same input, same output.

export type Rng = () => number;

/** mulberry32: a small 32-bit generator returning values in [0, 1). */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A separate stream per purpose, so adding a draw in one place does not reshuffle another. */
export function streamSeed(seed: number, salt: number): number {
  return Math.imul((seed ^ Math.imul(salt, 0x85ebca6b)) >>> 0, 0x9e3779b1) >>> 0;
}

export function range(rng: Rng, min: number, max: number): number {
  return min + (max - min) * rng();
}

export function randomInt(rng: Rng, min: number, maxInclusive: number): number {
  return min + Math.floor(rng() * (maxInclusive - min + 1));
}

/** Unit vector by rejection, using only sqrt. */
export function randomUnit(rng: Rng): [number, number, number] {
  for (;;) {
    const x = rng() * 2 - 1;
    const y = rng() * 2 - 1;
    const z = rng() * 2 - 1;
    const len2 = x * x + y * y + z * z;
    if (len2 > 1e-4 && len2 <= 1) {
      const len = Math.sqrt(len2);
      return [x / len, y / len, z / len];
    }
  }
}

/** FNV-1a over raw bytes, as 8 hex characters. For spotting identical meshes, not for security. */
export function fnv1a(bytes: Uint8Array, start = 0x811c9dc5): string {
  let hash = start >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
