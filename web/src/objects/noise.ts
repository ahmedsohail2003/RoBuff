// Seeded smooth 3D value noise. Smooth on purpose: rocks get lumps from this, not spikes.

import type { Rng } from './rng';

const TABLE_SIZE = 256;

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class SmoothNoise {
  private readonly perm = new Uint8Array(TABLE_SIZE * 2);
  private readonly values = new Float64Array(TABLE_SIZE);

  constructor(rng: Rng) {
    const order = new Uint8Array(TABLE_SIZE);
    for (let i = 0; i < TABLE_SIZE; i++) {
      order[i] = i;
      this.values[i] = rng() * 2 - 1;
    }
    for (let i = TABLE_SIZE - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const swap = order[i]!;
      order[i] = order[j]!;
      order[j] = swap;
    }
    for (let i = 0; i < TABLE_SIZE * 2; i++) this.perm[i] = order[i % TABLE_SIZE]!;
  }

  private lattice(ix: number, iy: number, iz: number): number {
    const p = this.perm;
    return this.values[p[p[p[ix & 255]! + (iy & 255)]! + (iz & 255)]!]!;
  }

  /** About -1 to 1. */
  sample(x: number, y: number, z: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);
    const u = fade(x - ix);
    const v = fade(y - iy);
    const w = fade(z - iz);
    const c00 = lerp(this.lattice(ix, iy, iz), this.lattice(ix + 1, iy, iz), u);
    const c10 = lerp(this.lattice(ix, iy + 1, iz), this.lattice(ix + 1, iy + 1, iz), u);
    const c01 = lerp(this.lattice(ix, iy, iz + 1), this.lattice(ix + 1, iy, iz + 1), u);
    const c11 = lerp(this.lattice(ix, iy + 1, iz + 1), this.lattice(ix + 1, iy + 1, iz + 1), u);
    return lerp(lerp(c00, c10, v), lerp(c01, c11, v), w);
  }

  /** Layered noise, each octave twice the frequency and half the amplitude. Normalized to about -1 to 1. */
  layered(x: number, y: number, z: number, octaves: number): number {
    let sum = 0;
    let amplitude = 1;
    let total = 0;
    let scale = 1;
    for (let i = 0; i < octaves; i++) {
      sum += amplitude * this.sample(x * scale, y * scale, z * scale);
      total += amplitude;
      amplitude *= 0.5;
      scale *= 2;
    }
    return sum / total;
  }
}
