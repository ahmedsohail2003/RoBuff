import { describe, expect, it } from 'vitest';
import { say } from '../format';
import { validate } from '../guardrail';
import { proveLift, type LiftRequest, type LiftTester } from '../lift';
import { MAX_HULL_VERT } from '../limits';
import { lines } from '../messages';
import type { RestPose } from '../receipt';
import { spec } from './helpers';

describe('honest receipt lines (S4 verifier notes)', () => {
  it('the hull line only claims MuJoCo collides with the same hull when it has at most maxhullvert points', () => {
    expect(lines.hullOk(18, 40)).toContain('MuJoCo collides with this same hull');
    const big = lines.hullOk(18, 361);
    expect(big).not.toMatch(/physics uses this hull/);
    expect(big).toContain(`at most ${MAX_HULL_VERT}`);
    expect(big).toContain('a little smaller');
    const measured = lines.hullMeasured(18, 361, 16.97, 64);
    expect(measured).toContain('5.7 percent smaller');
    expect(measured).toContain('measured after loading');
  });

  it('NO_SINGLE_SCALE says shrunk only when the allowed scale shrinks, and enlarged when it enlarges', () => {
    const disc = validate(spec({ kind: 'dish', width_mm: 60, height_mm: 3 }));
    const enlarged = disc.steps.find((s) => s.code === 'NO_SINGLE_SCALE')!;
    expect(enlarged.message).toContain('Even enlarged as far as');
    expect(enlarged.message).not.toContain('Shrunk');
    const needle = validate(spec({ kind: 'fragment', width_mm: 2, height_mm: 2000 }));
    const shrunk = needle.steps.find((s) => s.code === 'NO_SINGLE_SCALE')!;
    expect(shrunk.message).toContain('Shrunk to fit');
  });

  it('huge numbers read as powers of ten, not broken digit groups', () => {
    expect(say(5.87e23)).toBe('5.9 x 10^23');
    expect(say(1.2e9)).toBe('1,200,000,000');
  });

  it('with a rest pose, the lift test aims from it: rest yaws, rest widths and rest grip height', async () => {
    const receipt = validate(spec());
    const rest: RestPose = {
      scene: 'arena',
      position_m: [0, -0.22, 0],
      quat: [Math.cos(Math.PI / 8), 0, 0, Math.sin(Math.PI / 8)],
      yaw_candidates_deg: [105, 120, 90],
      narrow_width_mm: 30,
      lowest_mm: 0,
      height_mm: 50,
    };
    const calls: LiftRequest[] = [];
    const tester: LiftTester = {
      name: 'records',
      testLift: async (request) => {
        calls.push(request);
        return { simulated: true, rise_mm: 0 };
      },
    };
    await proveLift({ ...receipt, rest }, tester);
    expect(calls.map((c) => c.yaw_deg)).toEqual([105, 120, 90]);
    expect(calls.every((c) => c.yaw_frame === 'rest-world' && c.rest === rest)).toBe(true);
    expect(calls[0]!.grip_z_mm).toBe(25);
    const plain: LiftRequest[] = [];
    await proveLift(receipt, { name: 'plain', testLift: async (r) => (plain.push(r), { simulated: true, rise_mm: 0 }) });
    expect(plain.map((c) => c.yaw_deg)).toEqual(receipt.yaw_candidates_deg.slice(0, 3));
    expect(plain[0]!.yaw_frame).toBe('object');
  });
});
