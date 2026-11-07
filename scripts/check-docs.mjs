#!/usr/bin/env node
// Checks the public docs before a push: README.md has the required headings and the
// disclosure, nothing says TODO, and every local link in README.md and HOW_IT_WORKS.md
// points at a file that exists. Prints DOCS OK and exits 0, or lists each problem and exits 1.
// Run from anywhere: node scripts/check-docs.mjs
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = ['README.md', 'HOW_IT_WORKS.md'];

/** README level-2 headings, matched by prefix ("Modes" matches "Modes and keys"). */
const README_HEADINGS = [
  'What it does',
  'Try it',
  'Modes',
  'Real / simulated / mocked',
  'Results',
  'Limits',
  'Who this is for',
  'Provenance and disclosure',
];

/** Level-3 headings that must sit inside "Provenance and disclosure". */
const DISCLOSURE_PARTS = ['Built during UB Hacking 2026', 'Existed before', 'AI tools used and how', 'Simulated and mocked data'];

/** HOW_IT_WORKS.md level-2 headings, by prefix. */
const HOW_HEADINGS = ['Hand to arm', 'Friction grip', 'Delay and ghost', 'Guardrail and lift test', 'Gravity', 'Voice', 'Safety', 'Prepared answers'];

const problems = [];

function read(name) {
  const file = path.join(ROOT, name);
  if (!existsSync(file)) {
    problems.push(`${name} is missing`);
    return null;
  }
  return readFileSync(file, 'utf8');
}

/** Headings outside fenced code blocks, as { level, text, line }. */
function headings(text) {
  const out = [];
  let fenced = false;
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const m = !fenced && /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2], line: i + 1 });
  });
  return out;
}

function linesMatching(text, needle) {
  return text.split(/\r?\n/).filter((line) => line.includes(needle)).length;
}

/** Local link targets in [text](target) form, outside code blocks and inline code. */
function localLinks(text) {
  const out = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const bare = line.replace(/`[^`]*`/g, '');
    for (const m of bare.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
      out.push(target);
    }
  }
  return out;
}

const texts = {};
for (const name of DOCS) texts[name] = read(name);

for (const [name, text] of Object.entries(texts)) {
  if (text === null) continue;
  if (/TODO/.test(text)) problems.push(`${name} contains TODO (${linesMatching(text, 'TODO')} line(s))`);
  for (const target of localLinks(text)) {
    const file = decodeURIComponent(target.split('#')[0]);
    if (!existsSync(path.resolve(ROOT, file))) problems.push(`${name} links to ${target}, which does not exist`);
  }
}

const readme = texts['README.md'];
if (readme !== null) {
  const h2 = headings(readme).filter((h) => h.level === 2);
  for (const want of README_HEADINGS) {
    if (!h2.some((h) => h.text.startsWith(want))) problems.push(`README.md has no "## ${want}" heading`);
  }
  const all = headings(readme);
  const start = all.find((h) => h.level === 2 && h.text.startsWith('Provenance and disclosure'));
  if (start) {
    const next = all.find((h) => h.level <= 2 && h.line > start.line);
    const inside = all.filter((h) => h.level === 3 && h.line > start.line && (!next || h.line < next.line));
    for (const part of DISCLOSURE_PARTS) {
      if (!inside.some((h) => h.text.startsWith(part))) problems.push(`README.md disclosure has no "### ${part}" subsection`);
    }
  }
  if (linesMatching(readme, 'SIMULATION') < 1) problems.push('README.md never says SIMULATION');
  const spirit = linesMatching(readme, 'New for the author');
  if (spirit !== 1) problems.push(`README.md has ${spirit} "New for the author" lines, expected 1`);
  const privacy = linesMatching(readme, 'No camera frames leave');
  if (privacy !== 1) problems.push(`README.md has ${privacy} "No camera frames leave" lines, expected 1`);
  if (!readme.includes('in a keyword scan of 755 saved UB Hacking entries we found none')) {
    problems.push('README.md does not word the gallery claim as "in a keyword scan of 755 saved UB Hacking entries we found none ..."');
  }
  for (const name of ['WorkCell', 'EmberHacks', 'HandSignal']) {
    if (!readme.includes(name)) problems.push(`README.md does not name the earlier project ${name}`);
  }
  if (!/no code (?:from them )?(?:is|was) reused/i.test(readme)) problems.push('README.md does not state that no code was reused');
}

const how = texts['HOW_IT_WORKS.md'];
if (how !== null) {
  const h2 = headings(how).filter((h) => h.level === 2);
  for (const want of HOW_HEADINGS) {
    if (!h2.some((h) => h.text.startsWith(want))) problems.push(`HOW_IT_WORKS.md has no "## ${want}" heading`);
  }
  const answers = headings(how).filter((h) => h.level === 3).length;
  if (answers < 5) problems.push(`HOW_IT_WORKS.md has ${answers} prepared answers (### headings), expected at least 5`);
}

if (problems.length > 0) {
  for (const p of problems) console.log(`FAIL ${p}`);
  console.log(`DOCS NOT OK (${problems.length} problem${problems.length === 1 ? '' : 's'})`);
  process.exit(1);
}
console.log('DOCS OK');
