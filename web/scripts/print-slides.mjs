#!/usr/bin/env node
// Prints slides/index.html to slides/aftergrip-slides.pdf with the installed Chrome, one slide per page.
// Run from web/: node scripts/print-slides.mjs [output.pdf]
// The slides' print stylesheet sets the page size (13.333 x 7.5 in, 16:9) and one slide per page.
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SLIDES = path.join(ROOT, 'slides', 'index.html');
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, 'slides', 'aftergrip-slides.pdf'));

/** Page count of a PDF written by Chrome: one "/Type /Page" object per page (not "/Pages"). */
export function pdfPageCount(file) {
  const text = readFileSync(file).toString('latin1');
  return (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(SLIDES).href);
    await page.emulateMedia({ media: 'print' });
    mkdirSync(path.dirname(OUT), { recursive: true });
    await page.pdf({ path: OUT, preferCSSPageSize: true, printBackground: true });
  } finally {
    await browser.close();
  }
  console.log(`Wrote ${OUT} (${pdfPageCount(OUT)} pages)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
