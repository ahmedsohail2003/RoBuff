// Twelve varied requests: every kind, every material, odd sizes. Used by the gallery script and the MuJoCo tests.

import type { ValidateOptions } from './guardrail';
import type { ObjectSpec } from './spec';

const base = { roughness: 0.5, lumpiness: 0.5, why: 'gallery sample' } as const;

export const GALLERY_SPECS: readonly { label: string; spec: ObjectSpec; options?: ValidateOptions }[] = [
  { label: 'Bennu-like C-type sample', spec: { ...base, kind: 'asteroid', width_mm: 40, height_mm: 33, roughness: 0.6, lumpiness: 0.65, seed: 101955, material: 'c_type_rock', color: '#3b3734' } },
  { label: 'Rough C-type boulder', spec: { ...base, kind: 'asteroid', width_mm: 52, height_mm: 40, roughness: 1, lumpiness: 0.9, seed: 7, material: 'c_type_rock', color: '#45403c' } },
  { label: 'Smooth S-type pebble', spec: { ...base, kind: 'asteroid', width_mm: 24, height_mm: 20, roughness: 0.1, lumpiness: 0.2, seed: 42, material: 's_type_rock', color: '#8a7b68' } },
  { label: 'Asteroid the size of Texas, as a model', spec: { ...base, kind: 'asteroid', width_mm: 1.2e9, height_mm: 9e8, seed: 1845, material: 's_type_rock', color: '#7d705f' } },
  { label: 'Tiny chip, scaled up to grip', spec: { ...base, kind: 'asteroid', width_mm: 6, height_mm: 5, seed: 3, material: 'c_type_rock', color: '#3b3734' } },
  { label: 'S-type chip', spec: { ...base, kind: 'fragment', width_mm: 30, height_mm: 20, roughness: 0.7, seed: 25143, material: 's_type_rock', color: '#8a7b68' } },
  { label: 'Comet ice shard', spec: { ...base, kind: 'fragment', width_mm: 34, height_mm: 30, roughness: 0.8, lumpiness: 0.6, seed: 67, material: 'ice', color: '#cfe6f2' } },
  { label: 'Iron meteorite fragment', spec: { ...base, kind: 'fragment', width_mm: 26, height_mm: 18, seed: 1947, material: 'iron', color: '#5a5550' } },
  { label: 'CubeSat solar panel', spec: { ...base, kind: 'panel', width_mm: 50, height_mm: 10, lumpiness: 0.4, seed: 1, material: 'aluminium', color: '#1f3a6e' } },
  { label: 'Comms dish', spec: { ...base, kind: 'dish', width_mm: 48, height_mm: 20, roughness: 0.4, seed: 7, material: 'aluminium', color: '#d8d8d2' } },
  { label: 'Satellite bus', spec: { ...base, kind: 'bus', width_mm: 40, height_mm: 38, seed: 12, material: 'aluminium', color: '#b8b9bd' } },
  { label: 'Ice block, hard band, Earth (slips)', spec: { ...base, kind: 'bus', width_mm: 70, height_mm: 60, seed: 1, material: 'ice', color: '#dbeef7' }, options: { band: 'hard' } },
];
