import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRESETS, specFromText } from '../mock';
import { normalizeSpec, OBJECT_SPEC_SCHEMA } from '../spec';
import { MATERIALS } from '../materials';

describe('offline mock and spec', () => {
  it('(k) specFromText marks its output source offline-mock', () => {
    for (const text of ['an asteroid the size of Texas', 'a 3 cm iron meteorite', 'comet ice shard', 'cubesat', '', 'a 2 metre antenna mast']) {
      const out = specFromText(text);
      expect(out.source).toBe('offline-mock');
      expect(normalizeSpec(out.spec).clamps).toEqual([]);
    }
  });

  it('reads simple keywords', () => {
    const texas = specFromText('an asteroid the size of Texas');
    expect(texas.spec.kind).toBe('asteroid');
    expect(texas.spec.width_mm).toBe(1.2e9);
    const iron = specFromText('a 3 cm iron meteorite');
    expect(iron.spec).toMatchObject({ kind: 'asteroid', material: 'iron', width_mm: 30 });
    const ice = specFromText('a chunk of comet ice, jagged');
    expect(ice.spec.material).toBe('ice');
    expect(ice.spec.roughness).toBe(0.9);
    const mast = specFromText('a 2 metre antenna mast');
    expect(mast.spec).toMatchObject({ kind: 'fragment', height_mm: 2000, width_mm: 2 });
    expect(specFromText('same words').spec.seed).toBe(specFromText('same words').spec.seed);
    expect(specFromText('anything').spec.why).toContain('Offline mock');
  });

  it('has the five deep-space presets', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['bennu-sample', 's-type-chip', 'cubesat-panel', 'comms-dish', 'comet-ice-shard']);
    for (const p of PRESETS) {
      expect(normalizeSpec(p.spec).clamps).toEqual([]);
      expect(specFromText(p.text).spec).toEqual(p.spec);
    }
  });

  it('schema lists every field as required, with enums and ranges', () => {
    expect(OBJECT_SPEC_SCHEMA.required).toHaveLength(9);
    expect(OBJECT_SPEC_SCHEMA.properties.kind.enum).toEqual(['asteroid', 'panel', 'dish', 'bus', 'fragment']);
    expect(OBJECT_SPEC_SCHEMA.properties.material.enum).toEqual(Object.keys(MATERIALS));
    expect(OBJECT_SPEC_SCHEMA.properties.roughness).toMatchObject({ minimum: 0, maximum: 1 });
    expect(JSON.parse(JSON.stringify(OBJECT_SPEC_SCHEMA))).toEqual(OBJECT_SPEC_SCHEMA);
  });

  it('materials match the research numbers and label rock as sample density', () => {
    expect(MATERIALS.c_type_rock).toMatchObject({ density_g_cc: 1.6, density_range_g_cc: [1.2, 2.3], density_basis: 'sample density' });
    expect(MATERIALS.s_type_rock).toMatchObject({ density_g_cc: 3.2, density_range_g_cc: [2.2, 3.4], density_basis: 'sample density' });
    expect(MATERIALS.ice.density_g_cc).toBe(0.9);
    expect(MATERIALS.aluminium.density_g_cc).toBe(2.7);
    expect(MATERIALS.iron.density_g_cc).toBe(7.8);
    for (const m of Object.values(MATERIALS)) expect(m.friction).toBeGreaterThan(0);
  });

  it('source files stay pure: no DOM, no three.js, no Node built-ins, no imports from outside src/objects', () => {
    const dir = join(__dirname, '..');
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== 'test') walk(join(d, entry.name));
        else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(join(d, entry.name));
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/from ['"](three|node:|fs|path)/);
      expect(text, file).not.toMatch(/\b(document|window)\./);
      for (const match of text.matchAll(/from ['"](\.[^'"]*)['"]/g)) {
        expect(resolve(dirname(file), match[1]!).startsWith(dir), `${file} imports ${match[1]}`).toBe(true);
      }
      expect(text, file).not.toMatch(/maxhullvert="\$\{(?!MAX_HULL_VERT)/);
    }
  });
});
