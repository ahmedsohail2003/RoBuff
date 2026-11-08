// The request line is honest about approximation, and the spoken receipt states one size.
import { describe, expect, it } from 'vitest';
import { approximationLine } from '../approximation';
import { validate } from '../guardrail';
import type { Receipt } from '../receipt';
import { receiptLine } from '../../voice/speak';
import { spec } from './helpers';

describe('approximation and the spoken width', () => {
  it('names the closest shape only when the why says it approximated', () => {
    expect(approximationLine(spec({ kind: 'box', width_mm: 40, why: 'Approximated: a Tesla, as a car-shaped box.' }))).toBe('Closest shape I can make: a box, 40 mm across as asked.');
    expect(approximationLine(spec({ kind: 'asteroid', width_mm: 40, why: 'The closest kind is a rock.' }))).toContain('an asteroid');
    expect(approximationLine(spec({ kind: 'cylinder', width_mm: 66, why: 'A standard soda can.' }))).toBeNull();
  });

  it('the spoken Texas line states one size, its length, even when the settled width differs', () => {
    const r = validate(spec({ kind: 'asteroid', width_mm: 1.2e9, height_mm: 1e9, seed: 3 }));
    const planned = r.narrow_width_mm!;
    const settled: Receipt = { ...r, verdict: 'ADJUSTED', rest: { scene: 'arena', position_m: [0, 0, 0], quat: [1, 0, 0, 0], yaw_candidates_deg: [0], narrow_width_mm: planned + 3, lowest_mm: 0, height_mm: 40 } };
    const text = receiptLine(settled, true).text;
    console.log(`Texas spoken: ${text}`);
    // One millimetre figure only (plus the jaw limit, said once for a width rescale), never a planned and a settled width.
    const lengths = [...text.matchAll(/(\d[\d,.]*) millimetre/g)].map((m) => m[1]);
    const length = String(Math.round(Math.max(r.size_mm![0], r.size_mm![1])));
    expect(lengths.filter((v) => v !== length).length).toBeLessThanOrEqual(1);
    expect(lengths).toContain(length);
    expect(text).not.toMatch(/narrowest/);
    // The rescale names its two widths, so neither reads as the settled one.
    const wide = r.steps.find((s) => s.code === 'TOO_WIDE')!.message;
    expect(wide).toMatch(/model of it \d+ millimetres at its narrowest and \d+ at its widest, same proportions\./);
    expect(wide).not.toMatch(/\d+ across, same proportions/);
    const same: Receipt = { ...settled, rest: { ...settled.rest!, narrow_width_mm: planned } };
    expect(receiptLine(same, true).text).toMatch(/rock sample/);
    expect(receiptLine(same, true).text).toMatch(/\d+ grams/);
  });
});
