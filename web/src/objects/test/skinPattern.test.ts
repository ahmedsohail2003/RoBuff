// Procedural skins: deterministic, seamless at the edges, distinct per recipe, and fast enough
// to draw on the main thread.
import { describe, expect, it } from 'vitest';
import { colourWords, finishFor, proceduralSkin, recipeFor, type RecipeId } from '../skinPattern';

/** Mean absolute RGB difference between two columns (or rows) of an RGBA square. */
function lineDiff(rgba: Uint8ClampedArray, size: number, a: number, b: number, columns: boolean): number {
  let sum = 0;
  for (let k = 0; k < size; k++) {
    const pa = columns ? (k * size + a) * 4 : (a * size + k) * 4;
    const pb = columns ? (k * size + b) * 4 : (b * size + k) * 4;
    for (let c = 0; c < 3; c++) sum += Math.abs(rgba[pa + c]! - rgba[pb + c]!);
  }
  return sum / (size * 3);
}

/** The wrap seam (last line next to the first) is no worse than the roughest seam inside the image. */
function seamless(rgba: Uint8ClampedArray, size: number): { wrapX: number; wrapY: number; innerX: number; innerY: number } {
  let innerX = 0;
  let innerY = 0;
  for (let i = 0; i < size - 1; i++) {
    innerX = Math.max(innerX, lineDiff(rgba, size, i, i + 1, true));
    innerY = Math.max(innerY, lineDiff(rgba, size, i, i + 1, false));
  }
  return { wrapX: lineDiff(rgba, size, size - 1, 0, true), wrapY: lineDiff(rgba, size, size - 1, 0, false), innerX, innerY };
}

const PRESETS: [string, RecipeId][] = [
  ['gold', 'gold'],
  ['chrome', 'chrome'],
  ['brushed metal', 'brushed'],
  ['carbon fibre', 'carbon'],
  ['camouflage', 'camo'],
  ['wood', 'wood'],
  ['marble', 'marble'],
  ['galaxy', 'galaxy'],
  ['lava', 'lava'],
  ['checker', 'checker'],
  ['racing stripes', 'stripes'],
  ['rust', 'rust'],
];

describe('procedural skins', () => {
  it('reads the recipe and the colour words from free text', () => {
    expect(recipeFor('brushed gold with fine scratches')).toBe('gold');
    expect(recipeFor('a swirling purple galaxy nebula')).toBe('galaxy');
    expect(recipeFor('red with white racing stripes')).toBe('stripes');
    expect(recipeFor('carbon fiber')).toBe('carbon');
    expect(recipeFor('camo')).toBe('camo');
    expect(recipeFor('polka dots')).toBe('noise');
    expect(colourWords('red with white racing stripes and a red nose')).toEqual(['red', 'white']);
    expect(colourWords('Gray and grey')).toEqual(['grey']);
    expect(proceduralSkin('a swirling purple galaxy nebula', 64).matched).toEqual(['galaxy', 'purple']);
    expect(proceduralSkin('black', 64).matched).toEqual(['coloured noise', 'black']);
  });

  it('reads a metal finish from metal words and keeps matte looks matte', () => {
    const brushedGold = finishFor('brushed gold with fine scratches');
    expect(brushedGold.kind).toBe('metal');
    expect(brushedGold.metalness).toBeGreaterThanOrEqual(0.85);
    expect(brushedGold.bump).toBeGreaterThan(0);
    const chrome = finishFor('chrome');
    expect(chrome.kind).toBe('metal');
    // Polished chrome is glossier than brushed gold.
    expect(chrome.roughness).toBeLessThan(brushedGold.roughness);
    for (const text of ['a swirling purple galaxy nebula', 'black', 'rusty metal', 'wood', 'carbon fibre', 'camouflage']) {
      const f = finishFor(text);
      expect([text, f.kind, f.metalness, f.bump]).toEqual([text, 'matte', 0, 0]);
    }
  });

  it('takes the finish from the first material word', () => {
    expect(finishFor('a swirling purple galaxy nebula with tiny gold stars').kind).toBe('matte');
    expect(finishFor('brushed gold with fine scratches').kind).toBe('metal');
    expect(finishFor('gold with a little rust').kind).toBe('metal');
    expect(finishFor('rust over gold').kind).toBe('matte');
    expect(finishFor('gold, matte').kind).toBe('matte');
  });

  it('same text, same bytes; other text, other bytes', () => {
    const a = proceduralSkin('Carbon  fibre', 256);
    const b = proceduralSkin('carbon fibre', 256);
    expect(a.rgba.length).toBe(256 * 256 * 4);
    expect(Buffer.from(a.rgba).equals(Buffer.from(b.rgba))).toBe(true);
    expect(Buffer.from(proceduralSkin('polka dots', 256).rgba).equals(Buffer.from(proceduralSkin('tiger fur', 256).rgba))).toBe(false);
    for (let i = 3; i < a.rgba.length; i += 4 * 101) expect(a.rgba[i]).toBe(255);
  });

  it('every preset and the noise fallback tile seamlessly: the wrap seam is no worse than the roughest seam inside', () => {
    for (const [text] of [...PRESETS, ['tiger fur', 'noise'] as [string, RecipeId], ['purple', 'noise'] as [string, RecipeId]]) {
      const skin = proceduralSkin(text, 256);
      const s = seamless(skin.rgba, 256);
      expect(s.wrapX, `${text} left/right`).toBeLessThanOrEqual(s.innerX + 1);
      expect(s.wrapY, `${text} top/bottom`).toBeLessThanOrEqual(s.innerY + 1);
    }
    // The check has teeth: a plain left-to-right ramp has a hard seam.
    const ramp = new Uint8ClampedArray(256 * 256 * 4);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) ramp.fill(x, (y * 256 + x) * 4, (y * 256 + x) * 4 + 3);
    const r = seamless(ramp, 256);
    expect(r.wrapX).toBeGreaterThan(r.innerX + 1);
  });

  it('each preset recipe is its own look: distinct recipes and distinct mean colours', () => {
    const means: [string, number[]][] = [];
    for (const [text, id] of PRESETS) {
      const skin = proceduralSkin(text, 128);
      expect(skin.recipe, text).toBe(id);
      const mean = [0, 0, 0];
      for (let i = 0; i < skin.rgba.length; i += 4) for (let c = 0; c < 3; c++) mean[c] = mean[c]! + skin.rgba[i + c]!;
      means.push([text, mean.map((m) => m / (128 * 128))]);
      // Not one flat colour either: some spread across the image.
      let lo = 255;
      let hi = 0;
      for (let i = 0; i < skin.rgba.length; i += 4) {
        lo = Math.min(lo, skin.rgba[i]!);
        hi = Math.max(hi, skin.rgba[i]!);
      }
      expect(hi - lo, `${text} has texture`).toBeGreaterThan(20);
    }
    expect(new Set(PRESETS.map(([, id]) => id)).size).toBe(PRESETS.length);
    // Distinct mean colours: every pair of presets is at least 20 apart in mean RGB (0-255 per channel).
    for (let i = 0; i < means.length; i++) {
      for (let j = i + 1; j < means.length; j++) {
        const [a, ma] = means[i]!;
        const [b, mb] = means[j]!;
        const apart = Math.hypot(ma[0]! - mb[0]!, ma[1]! - mb[1]!, ma[2]! - mb[2]!);
        expect(apart, `${a} vs ${b} mean colour`).toBeGreaterThan(20);
      }
    }
    // Pairwise, no two presets give the same image.
    const images = PRESETS.map(([t]) => Buffer.from(proceduralSkin(t, 64).rgba));
    for (let i = 0; i < images.length; i++) for (let j = i + 1; j < images.length; j++) expect(images[i]!.equals(images[j]!)).toBe(false);
  });

  it('colour words change the result: a red checker is not a black and white one', () => {
    const plain = proceduralSkin('checker', 64).rgba;
    const red = proceduralSkin('red checker', 64).rgba;
    expect(Buffer.from(plain).equals(Buffer.from(red))).toBe(false);
    let reds = 0;
    for (let i = 0; i < red.length; i += 4) if (red[i]! > 150 && red[i + 1]! < 60) reds++;
    expect(reds).toBeGreaterThan((64 * 64) / 4);
  });

  // Timed in CPU time of this test process (Vitest runs each file in its own process): the
  // generator is synchronous and single-threaded, so CPU time is its own cost even when the
  // full suite loads the machine. Wall time is printed beside it.
  it('draws a 1024 x 1024 skin in under 150 ms of CPU for every preset (fastest of 3, Node)', () => {
    const cpu: Record<string, number> = {};
    const wall: Record<string, number> = {};
    for (const [text] of [...PRESETS, ['a swirling purple galaxy nebula', 'galaxy'] as [string, RecipeId], ['polka dots', 'noise'] as [string, RecipeId]]) {
      const cpuRuns: number[] = [];
      const wallRuns: number[] = [];
      for (let k = 0; k < 3; k++) {
        const c0 = process.cpuUsage();
        const t0 = performance.now();
        const skin = proceduralSkin(text, 1024);
        wallRuns.push(performance.now() - t0);
        const used = process.cpuUsage(c0);
        cpuRuns.push((used.user + used.system) / 1000);
        expect(skin.rgba.length).toBe(1024 * 1024 * 4);
      }
      cpu[text] = Math.round(Math.min(...cpuRuns) * 10) / 10;
      wall[text] = Math.round(Math.min(...wallRuns) * 10) / 10;
    }
    console.log(`proceduralSkin 1024x1024 fastest CPU ms: ${JSON.stringify(cpu)}`);
    console.log(`proceduralSkin 1024x1024 fastest wall ms: ${JSON.stringify(wall)}`);
    for (const [text, ms] of Object.entries(cpu)) expect(ms, text).toBeLessThan(150);
  });
});
