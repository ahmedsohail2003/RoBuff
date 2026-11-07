// The key server keeps its own copy of the Gemini schema (server/commandSchema.json, plain
// JSON so the server needs no build step). This test keeps it equal to OBJECT_SPEC_SCHEMA.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GRAVITY_PRESETS } from '../sim/gravity';
import { OBJECT_SPEC_SCHEMA } from '../objects/spec';
import { chunkLine } from './speak';

const schema = JSON.parse(readFileSync(path.join(import.meta.dirname, '../../../server/commandSchema.json'), 'utf8')) as {
  properties: Record<string, { enum?: string[] }>;
  required: string[];
  propertyOrdering: string[];
};

describe('server command schema', () => {
  it('is OBJECT_SPEC_SCHEMA extended by intent and gravity', () => {
    const { intent, gravity, ...spec } = schema.properties;
    expect(JSON.parse(JSON.stringify(spec))).toEqual(JSON.parse(JSON.stringify(OBJECT_SPEC_SCHEMA.properties)));
    expect(intent?.enum).toEqual(['spawn', 'set_gravity', 'home', 'help', 'none']);
    expect(gravity?.enum).toEqual([...GRAVITY_PRESETS.map((p) => p.id), 'none']);
    expect(schema.required).toEqual(['intent', 'gravity', ...OBJECT_SPEC_SCHEMA.required]);
    expect(schema.propertyOrdering).toEqual(['intent', 'gravity', ...OBJECT_SPEC_SCHEMA.propertyOrdering]);
  });
});

describe('spoken line chunks', () => {
  it('splits long lines into pieces of at most 160 characters without losing words', () => {
    const line = 'This is a long receipt line. '.repeat(20).trim();
    const pieces = chunkLine(line);
    expect(pieces.every((p) => p.length <= 160)).toBe(true);
    expect(pieces.join(' ')).toBe(line);
    expect(chunkLine('GO')).toEqual(['GO']);
  });
});
