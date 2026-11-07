import { describe, expect, it } from 'vitest';
import { handsFromUrl } from './handTracker';

describe('?hands= switch (M1 step 6)', () => {
  it('is 1 by default and 2 only when asked', () => {
    expect(handsFromUrl('')).toBe(1);
    expect(handsFromUrl('?input=webcam')).toBe(1);
    expect(handsFromUrl('?hands=1')).toBe(1);
    expect(handsFromUrl('?hands=2&input=webcam')).toBe(2);
    expect(handsFromUrl('?hands=3')).toBe(1);
  });
});
