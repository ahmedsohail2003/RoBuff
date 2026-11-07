import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIXED_PAD_SITE, GRIPPER_SITE, MOVING_PAD_SITE, meshFilesIn, patchArmXml } from './armXml';

const armXml = readFileSync('public/models/so_arm100/so_arm100.xml', 'utf8');

describe('patchArmXml', () => {
  it('adds the sites inside the jaw bodies', () => {
    const patched = patchArmXml(armXml);
    expect(patched).toMatch(new RegExp(`<body name="Fixed_Jaw"[^>]*>\\s*<site name="${GRIPPER_SITE}"`));
    expect(patched).toContain(`<site name="${FIXED_PAD_SITE}"`);
    expect(patched).toMatch(new RegExp(`<body name="Moving_Jaw"[^>]*>\\s*<site name="${MOVING_PAD_SITE}"`));
  });

  it('fails loudly when a body is missing', () => {
    expect(() => patchArmXml('<mujoco/>')).toThrow(/Fixed_Jaw/);
  });
});

describe('meshFilesIn', () => {
  it('finds every mesh file', () => {
    expect(meshFilesIn(armXml)).toHaveLength(18);
    expect(meshFilesIn(armXml)).toContain('Moving_Jaw_Collision_3.stl');
  });
});
