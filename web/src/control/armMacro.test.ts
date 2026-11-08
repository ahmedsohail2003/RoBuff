import { describe, expect, it } from 'vitest';
import type { LiveObject } from '../sim/liveObject';
import type { Vec3 } from '../sim/simulation';
import { checkPick, pickLine, planDrop, planPick, planPlace } from './armMacro';
import { directionVector, moveDuration, planMove, sayCm, screenAxes } from './voiceMotion';

/** A box of the given size standing on the floor at (x, y), as world corner points. */
function box(x: number, y: number, w: number, d: number, h: number): LiveObject {
  const points: number[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const z of [0, h]) points.push(x + (sx * w) / 2, y + (sy * d) / 2, z);
  return { body: 'cube', com: [x, y, h / 2], position: [x, y, h / 2], quat: [1, 0, 0, 0], points: Float64Array.from(points), lowest: 0, height: h };
}
const JAW = { range: [-0.174, 1.75] as [number, number], angleForGap: (gap: number) => Math.min(1.75, Math.max(-0.174, -0.174 + gap * 15)) };
const HOME: Vec3 = [0, -0.2389, 0.0802];

describe('voice motion planning', () => {
  it('times a move by the 0.10 m/s min-jerk peak, never under 0.5 s', () => {
    expect(moveDuration(0.05)).toBeCloseTo(0.9375, 6);
    expect(moveDuration(0.005)).toBe(0.5);
  });

  it('clamps a move to the hand box and says so', () => {
    const plan = planMove(HOME, [0, -0.3, 0]);
    expect(plan.clamped).toBe(true);
    expect(plan.distance).toBeLessThan(0.3);
    const fine = planMove(HOME, [0.05, 0, 0]);
    expect(fine.clamped).toBe(false);
    expect(fine.distance).toBeCloseTo(0.05, 9);
  });

  it('forward and back are radial from the base axis; up and down are world z', () => {
    expect(directionVector('forward', 0.7, HOME)).toEqual([0, -1, 0]);
    expect(directionVector('back', 0.7, HOME)[1]).toBeCloseTo(1, 9);
    expect(directionVector('up', 0.7, HOME)).toEqual([0, 0, 1]);
    const toward = directionVector('toward', 0.6987, HOME);
    expect(toward[0]).toBeCloseTo(screenAxes(0.6987).away[0] * -1, 9);
    expect(sayCm(2.5)).toBe('2.5 centimetres');
  });
});

describe('voice pick, place and drop planning', () => {
  it('plans the lift test grasp on a 30 mm cube: above, down, close, lift, hold', () => {
    const plan = planPick(box(0, -0.22, 0.03, 0.03, 0.03), JAW, HOME);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.steps.map((s) => s.name)).toEqual(['above', 'down', 'close', 'lift', 'hold']);
    expect(plan.width).toBeCloseTo(0.03, 9);
    expect(plan.steps[3]!.waypoint[2] - plan.grasp[2]).toBeCloseTo(0.08, 9);
    expect(plan.steps[2]!.grip).toBe(1);
  });

  it('refuses widths outside 10 to 70 mm and grasps out of reach, with numbers', () => {
    const wide = planPick(box(0, -0.22, 0.09, 0.09, 0.03), JAW, HOME);
    expect(wide.ok).toBe(false);
    if (!wide.ok) expect(wide.refuse).toMatch(/90 millimetres.*10 to 70/);
    const thin = planPick(box(0, -0.22, 0.006, 0.006, 0.03), JAW, HOME);
    expect(thin.ok).toBe(false);
    const far = planPick(box(0, -0.6, 0.03, 0.03, 0.03), JAW, HOME);
    expect(far.ok).toBe(false);
    if (!far.ok) expect(far.refuse).toMatch(/out of my reach/);
  });

  it('puts the lowest point 2 mm over the floor, never below 12 mm site height, then rises 7 cm', () => {
    const held: LiveObject = { ...box(0, -0.22, 0.03, 0.03, 0.03), lowest: 0.06 };
    const steps = planPlace(held, [0, -0.22, 0.09], 0.7);
    expect(steps[0]!.waypoint[2]).toBeCloseTo(0.032, 9);
    expect(steps[2]!.waypoint[2] - steps[0]!.waypoint[2]).toBeCloseTo(0.07, 9);
    expect(planPlace({ ...held, lowest: 0.01 }, [0, -0.22, 0.013], 0.7)[0]!.waypoint[2]).toBe(0.012);
    expect(planDrop([0, -0.22, 0.1])[0]!.grip).toBe(0);
  });

  it('checks a pick with the rise, both jaws and a closed grip, and says it plainly', () => {
    const good = checkPick(0.077, ['Fixed_Jaw', 'Moving_Jaw'], 1);
    expect(good.ok).toBe(true);
    expect(pickLine(good)).toBe('Holding it, up 77 millimetres, both jaws on it.');
    expect(checkPick(0.077, ['Fixed_Jaw'], 1).ok).toBe(false);
    expect(checkPick(0.04, ['Fixed_Jaw', 'Moving_Jaw'], 1).ok).toBe(false);
    expect(checkPick(0.077, ['Fixed_Jaw', 'Moving_Jaw'], 0.99).ok).toBe(false);
    expect(pickLine(checkPick(0.006, ['Moving_Jaw'], 1))).toMatch(/rose 6 millimetres with only the moving jaw/);
  });
});
