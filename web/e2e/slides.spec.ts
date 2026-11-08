// M9b slides: every section renders and the arrow keys move between them; the printed PDF has
// one page per slide (8 to 10); every number on the slides also appears in README.md or
// HOW_IT_WORKS.md; the results slide and the teleprompter's results beat say "not yet measured"
// while they are marked pending. The slides are plain files, opened from disk (no app server needed).
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';

const EVIDENCE_DIR = path.resolve(process.env.EVIDENCE_DIR ?? path.join(import.meta.dirname, '../evidence'));
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SLIDES_DIR = path.join(ROOT, 'slides');
const SLIDES_URL = pathToFileURL(path.join(SLIDES_DIR, 'index.html')).href;
const TELEPROMPTER_URL = pathToFileURL(path.join(SLIDES_DIR, 'teleprompter.html')).href;
const COMMITTED_PDF = path.join(SLIDES_DIR, 'aftergrip-slides.pdf');

/**
 * Numbers as written: 2.56, 384,400, 4.0.0, 0.10. A digit run glued to a letter or underscore
 * (SO-ARM100, so_arm100, a user name in a URL) is an identifier, not a number, and is skipped.
 */
function numberTokens(text: string): string[] {
  return text.match(/(?<![A-Za-z0-9_.,])\d+(?:[.,]\d+)*/g) ?? [];
}

/** Page count of a Chrome PDF: one "/Type /Page" object per page ("/Pages" is the tree node). */
function pdfPageCount(file: string): number {
  return (readFileSync(file).toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

test('slides render, step with the arrow keys, print 8-10 pages, and use only documented numbers', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

  const outDir = path.join(EVIDENCE_DIR, 'slides');
  mkdirSync(outDir, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(SLIDES_URL);

  const count = await page.locator('section.slide').count();
  expect(count).toBeGreaterThanOrEqual(8);
  expect(count).toBeLessThanOrEqual(10);

  // Walk forward with the arrow key: exactly one slide shows at a time, each has a heading,
  // text and the SIMULATION footer, and nothing spills past the bottom of the screen.
  const seen: { n: number; id: string; heading: string; overflowPx: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (i > 0) await page.keyboard.press('ArrowRight');
    await expect(page.locator('body')).toHaveAttribute('data-current', String(i + 1));
    const visible = page.locator('section.slide:visible');
    await expect(visible).toHaveCount(1);
    const info = await visible.evaluate((el) => ({
      id: el.id,
      heading: (el.querySelector('h1, h2')?.textContent ?? '').trim(),
      text: (el.textContent ?? '').trim(),
      sim: el.querySelector('.footer .sim')?.textContent ?? '',
      overflowPx: Math.max(0, el.scrollHeight - el.clientHeight),
    }));
    expect(info.heading.length, `slide ${i + 1} heading`).toBeGreaterThan(0);
    expect(info.text.length, `slide ${i + 1} text`).toBeGreaterThan(40);
    expect(info.sim, `slide ${i + 1} SIMULATION footer`).toBe('SIMULATION');
    expect(info.overflowPx, `slide ${i + 1} overflow`).toBeLessThanOrEqual(2);
    await page.screenshot({ path: path.join(outDir, `slide-${String(i + 1).padStart(2, '0')}.png`) });
    seen.push({ n: i + 1, id: info.id, heading: info.heading, overflowPx: info.overflowPx });
  }
  // Past the end stays on the last slide; Left goes back; Home and End jump.
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('body')).toHaveAttribute('data-current', String(count));
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('body')).toHaveAttribute('data-current', String(count - 1));
  await page.keyboard.press('Home');
  await expect(page.locator('body')).toHaveAttribute('data-current', '1');
  await page.keyboard.press('End');
  await expect(page.locator('body')).toHaveAttribute('data-current', String(count));

  // Every number on the slides appears in README.md or HOW_IT_WORKS.md.
  // Text nodes joined with spaces: textContent would glue table cells together ("Earth9.82"),
  // and a number glued to a letter is skipped as an identifier.
  const slideText = await page.locator('section.slide').evaluateAll((els) =>
    els
      .map((el) => {
        const parts: string[] = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) parts.push(node.textContent ?? '');
        return parts.join(' ');
      })
      .join('\n'),
  );
  for (const value of ['9.82', '3.73', '1.62', '384,400']) expect(numberTokens(slideText), `tokenizer sees ${value}`).toContain(value);
  const docs = readFileSync(path.join(ROOT, 'README.md'), 'utf8') + '\n' + readFileSync(path.join(ROOT, 'HOW_IT_WORKS.md'), 'utf8');
  const documented = new Set(numberTokens(docs));
  const onSlides = [...new Set(numberTokens(slideText))];
  const missing = onSlides.filter((n) => !documented.has(n));
  expect(onSlides.length).toBeGreaterThan(10);
  expect(missing, 'numbers on the slides that README.md and HOW_IT_WORKS.md do not contain').toEqual([]);

  // The results slide claims nothing until the gate result exists.
  const results = page.locator('section.slide[id="s-results"]');
  await expect(results).toHaveCount(1);
  const pending = (await results.getAttribute('data-results')) === 'pending';
  if (pending) expect(await results.textContent()).toContain('not yet measured');

  // Print: one page per slide, 8 to 10 pages; the committed PDF matches the slide count.
  await page.emulateMedia({ media: 'print' });
  const printed = path.join(outDir, 'slides-print.pdf');
  await page.pdf({ path: printed, preferCSSPageSize: true, printBackground: true });
  const printedPages = pdfPageCount(printed);
  expect(printedPages).toBe(count);
  expect(existsSync(COMMITTED_PDF), 'slides/aftergrip-slides.pdf exists (node scripts/print-slides.mjs)').toBe(true);
  const committedPages = pdfPageCount(COMMITTED_PDF);
  expect(committedPages).toBe(count);
  // A reminder, not a failure: a fresh clone can write the two files in either order.
  const pdfOlderThanHtml = statSync(COMMITTED_PDF).mtimeMs < statSync(path.join(SLIDES_DIR, 'index.html')).mtimeMs;
  if (pdfOlderThanHtml) console.log('NOTE slides/aftergrip-slides.pdf is older than slides/index.html: reprint with npm run slides:pdf');

  // Teleprompter: the beats with timings, large type, and the results beat still a placeholder.
  await page.emulateMedia({ media: 'screen' });
  await page.goto(TELEPROMPTER_URL);
  const beats = await page.locator('.beat').evaluateAll((els) =>
    els.map((el) => ({
      when: el.querySelector('.when')?.textContent ?? '',
      words: el.querySelector('.words')?.textContent ?? '',
      pending: el.getAttribute('data-results') === 'pending',
      fontPx: parseFloat(getComputedStyle(el.querySelector('.words')!).fontSize),
    })),
  );
  expect(beats.length).toBe(8);
  for (const beat of beats) {
    expect(beat.when).toMatch(/^\d:\d\d-\d:\d\d$/);
    expect(beat.words.length).toBeGreaterThan(20);
    expect(beat.fontPx).toBeGreaterThanOrEqual(32);
  }
  expect(beats[beats.length - 1]!.when.endsWith('2:40')).toBe(true);
  const resultBeat = beats.find((b) => b.pending);
  if (resultBeat) expect(resultBeat.words).toContain('not yet measured');
  await page.screenshot({ path: path.join(outDir, 'teleprompter.png') });

  const report = { count, seen, onSlides, missing, pending, printedPages, committedPages, pdfOlderThanHtml, beats: beats.map((b) => b.when), problems };
  console.log(`SLIDES ${JSON.stringify(report)}`);
  writeFileSync(path.join(outDir, 'slides.json'), JSON.stringify(report, null, 2));
  expect(problems).toEqual([]);
});
