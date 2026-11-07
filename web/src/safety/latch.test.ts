import { describe, expect, it } from 'vitest';
import { isStopKey, StopLatch } from './latch';

describe('StopLatch', () => {
  it('stays set until cleared, and a second stop changes nothing', () => {
    const latch = new StopLatch();
    const seen: boolean[] = [];
    latch.onChange((stopped) => seen.push(stopped));
    expect(latch.stopped).toBe(false);
    expect(latch.stop('space key', 1.5)).toBe(true);
    expect(latch.stop('stop gesture', 2)).toBe(false);
    expect(latch.stopped).toBe(true);
    expect(latch.why).toBe('space key');
    expect(latch.since).toBe(1.5);
    expect(latch.clear()).toBe(true);
    expect(latch.clear()).toBe(false);
    expect(latch.stopped).toBe(false);
    expect(latch.why).toBeNull();
    expect(latch.stops).toBe(1);
    expect(seen).toEqual([true, false]);
  });

  it('Space stops, except while typing in a text field', () => {
    const space = { code: 'Space', key: ' ', repeat: false };
    expect(isStopKey(space, null)).toBe(true);
    expect(isStopKey(space, { tagName: 'BUTTON' } as unknown as EventTarget)).toBe(true);
    expect(isStopKey(space, { tagName: 'INPUT' } as unknown as EventTarget)).toBe(false);
    expect(isStopKey(space, { tagName: 'textarea' } as unknown as EventTarget)).toBe(false);
    expect(isStopKey(space, { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(false);
    expect(isStopKey({ code: 'KeyG', key: 'g', repeat: false }, null)).toBe(false);
  });
});
