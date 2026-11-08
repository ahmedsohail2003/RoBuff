#!/usr/bin/env node
// Pre-judging smoke test: npm run smoke (from web/).
// Runs the build, the unit tests and the scripted pick in Chrome; checks the vendored files
// (arm model, MuJoCo and MediaPipe WASM, hand model), that web/.env is ignored by git and
// not tracked, and that README.md has its required headings. Then prints the manual
// checklist for the judging table and SMOKE OK (exit 0), or SMOKE FAILED (exit 1).
// The browser test starts its own dev server on E2E_PORT (default 5199) and writes its
// reports to EVIDENCE_DIR (default web/evidence/smoke, git-ignored).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const WEB = path.resolve(import.meta.dirname, '..');
const ROOT = path.resolve(WEB, '..');
const EVIDENCE_DIR = path.resolve(process.env.EVIDENCE_DIR ?? path.join(WEB, 'evidence', 'smoke'));
const PORT = process.env.E2E_PORT ?? '5199';

const README_HEADINGS = ['What it does', 'Try it', 'Modes', 'Real / simulated / mocked', 'Results', 'Limits', 'Who this is for', 'Provenance and disclosure'];

const failures = [];

function line(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/** Runs a command in web/, returns { status, out } with ANSI codes stripped. */
function run(command, env = {}) {
  console.log(`\n> ${command}`);
  const started = Date.now();
  const result = spawnSync(command, {
    cwd: WEB,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  const out = stripAnsi(`${result.stdout ?? ''}${result.stderr ?? ''}`);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  return { status: result.status, out, seconds };
}

function tail(text, n = 25) {
  return text.trim().split(/\r?\n/).slice(-n).join('\n');
}

function fileSize(rel) {
  const file = path.join(WEB, rel);
  return existsSync(file) ? statSync(file).size : -1;
}

console.log('Aftergrip pre-judging smoke test');

// 1. Build (type check and Vite bundle).
{
  const r = run('npm run build');
  if (r.status !== 0) console.log(tail(r.out));
  line(r.status === 0, 'build', `exit ${r.status}, ${r.seconds} s`);
}

// 2. Unit tests.
{
  const r = run('npx vitest run');
  const files = /Test Files\s+(.+)/.exec(r.out)?.[1]?.trim() ?? '?';
  const tests = /\n\s*Tests\s+(.+)/.exec(r.out)?.[1]?.trim() ?? '?';
  if (r.status !== 0) console.log(tail(r.out, 40));
  line(r.status === 0, 'unit tests', `files ${files}; tests ${tests}; ${r.seconds} s`);
}

// 3. The scripted pick in Chrome (two tests: one pick, then 5 repeats from reset).
{
  const r = run('npx playwright test e2e/s2-pick.spec.ts', { EVIDENCE_DIR, E2E_PORT: PORT });
  const passed = /(\d+) passed/.exec(r.out)?.[1] ?? '0';
  let repeat = 'no report';
  const report = path.join(EVIDENCE_DIR, 's2-repeat.json');
  let fresh = false;
  if (existsSync(report)) {
    const s = JSON.parse(readFileSync(report, 'utf8'));
    fresh = statSync(report).mtimeMs >= Date.now() - Number(r.seconds) * 1000 - 5000;
    repeat = `${s.successes}/${s.attempts}`;
  }
  if (r.status !== 0) console.log(tail(r.out, 40));
  line(r.status === 0 && fresh && repeat === '5/5', 's2 pick', `${passed} passed, picks ${repeat}, port ${PORT}, ${r.seconds} s`);
}

// 4. Vendored files: the app needs no network for these.
{
  const stls = existsSync(path.join(WEB, 'public/models/so_arm100/assets'))
    ? readdirSync(path.join(WEB, 'public/models/so_arm100/assets')).filter((f) => f.toLowerCase().endsWith('.stl')).length
    : 0;
  const builtWasm = existsSync(path.join(WEB, 'dist/assets')) ? readdirSync(path.join(WEB, 'dist/assets')).filter((f) => /^mujoco.*\.wasm$/.test(f)) : [];
  const checks = [
    ['arm model so_arm100.xml', 'public/models/so_arm100/so_arm100.xml'],
    ['arm scene scene.xml', 'public/models/so_arm100/scene.xml'],
    ['MuJoCo wasm (package)', 'node_modules/@mujoco/mujoco/mujoco.wasm'],
    ['MediaPipe wasm', 'public/mediapipe/wasm/vision_wasm_internal.wasm'],
    ['MediaPipe wasm loader', 'public/mediapipe/wasm/vision_wasm_internal.js'],
    ['hand model hand_landmarker.task', 'public/mediapipe/hand_landmarker.task'],
  ];
  for (const [label, rel] of checks) {
    const size = fileSize(rel);
    line(size > 0, `vendored ${label}`, size > 0 ? `${size.toLocaleString('en-US')} bytes` : `missing ${rel}`);
  }
  line(stls > 0, 'vendored arm meshes', `${stls} STL files`);
  line(builtWasm.length === 1, 'MuJoCo wasm in the build', builtWasm.join(', ') || 'none in dist/assets');
}

// 5. web/.env is ignored and not tracked.
{
  const ignored = spawnSync('git', ['check-ignore', '-q', '.env'], { cwd: WEB }).status === 0;
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '.env'], { cwd: WEB, stdio: 'ignore' }).status === 0;
  line(ignored && !tracked, '.env ignored by git', `${ignored ? 'ignored' : 'NOT ignored'}, ${tracked ? 'TRACKED' : 'not tracked'}`);
}

// 6. README headings.
{
  const readme = path.join(ROOT, 'README.md');
  const text = existsSync(readme) ? readFileSync(readme, 'utf8') : '';
  const h2 = text.split(/\r?\n/).filter((l) => /^##\s/.test(l)).map((l) => l.replace(/^##\s+/, '').trim());
  const missing = README_HEADINGS.filter((want) => !h2.some((h) => h.startsWith(want)));
  line(missing.length === 0, 'README headings', missing.length === 0 ? `${README_HEADINGS.length} of ${README_HEADINGS.length} present` : `missing ${missing.join(', ')}`);
}

console.log(`
Manual checklist (judging table; docs/DEMO.md has the full runbook):
  [ ] Laptop charged and plugged in; phone hotspot ready.
  [ ] Chrome set to high performance (Windows Settings > System > Display > Graphics).
  [ ] cd web && npm run build && npm run preview, then open http://localhost:4173/?input=webcam&hands=2
  [ ] Allow the camera; wait for "tracking warm" (the first detection can take about 10 s cold).
  [ ] Tracking time under 50 ms on screen; if not, use ?hands=1.
  [ ] One Direct pick works; leave the app in Direct mode.
  [ ] Webcam tested in the room's light.
  [ ] Backup video on the laptop, ready to play.
  [ ] Fallbacks: no camera or no hand for 10 s -> ?input=mouse and say so; a crash -> reload.`);

if (failures.length > 0) {
  console.log(`\nSMOKE FAILED (${failures.length}): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nSMOKE OK');
