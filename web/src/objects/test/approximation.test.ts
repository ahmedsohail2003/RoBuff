// The request line is honest about approximation, and the spoken receipt states one width.
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

  it('the Texas receipt says plainly that the settled width was measured after it settled', () => {
    const r = validate(spec({ kind: 'asteroid', width_mm: 1.2e9, height_mm: 1e9, seed: 3 }));
    const planned = r.narrow_width_mm!;
    const settled: Receipt = { ...r, verdict: 'ADJUSTED', rest: { scene: 'arena', position_m: [0, 0, 0], quat: [1, 0, 0, 0], yaw_candidates_deg: [0], narrow_width_mm: planned + 3, lowest_mm: 0, height_mm: 40 } };
    const text = receiptLine(settled, true).text;
    console.log(`Texas spoken: ${text}`);
    expect(text).toMatch(/After it settled it measured \d[\d,.]* millimetres at its narrowest\./);
    expect(text).not.toMatch(/Adjusted: \d+ millimetres across/);
    // The rescale names its two widths, so neither reads as the settled one.
    const wide = r.steps.find((s) => s.code === 'TOO_WIDE')!.message;
    expect(wide).toMatch(/model of it \d+ millimetres at its narrowest and \d+ at its widest, same proportions\./);
    expect(wide).not.toMatch(/\d+ across, same proportions/);
    const same: Receipt = { ...settled, rest: { ...settled.rest!, narrow_width_mm: planned } };
    expect(receiptLine(same, true).text).toMatch(/Adjusted: \d+ millimetres across, \d+ grams\./);
  });
});
