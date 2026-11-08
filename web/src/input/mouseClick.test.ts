import { describe, expect, it } from 'vitest';
import { CLICK_SLOP_PX, isClick } from './mouseSource';

describe('mouse click on the view', () => {
  it('counts a press and release in place as a click', () => {
    expect(isClick({ x: 100, y: 100 }, { x: 102, y: 101 })).toBe(true);
  });

  it('does not count a drag as a click', () => {
    expect(isClick({ x: 100, y: 100 }, { x: 100 + CLICK_SLOP_PX + 1, y: 100 })).toBe(false);
  });
});
