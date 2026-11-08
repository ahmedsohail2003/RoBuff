// Builds the backup video for the submission from the recorded demo path (M9c-early).
//
//   node scripts/make-backup-video.mjs [--update-docs]
//
// Reads $EVIDENCE_DIR/demo-path.webm and demo-path.json (written by e2e/demo-path.spec.ts; the
// folder is web/evidence unless EVIDENCE_DIR is set) and the caption text from docs/captions.srt,
// one entry per beat. Each caption is retimed to its beat on the video, burned in, and the result is $EVIDENCE_DIR/aftergrip-backup.mp4: 1920x1080, H.264, 30 fps, with a silent
// AAC track (YouTube wants a file with audio). --update-docs also writes the retimed captions back
// to docs/captions.srt, so the committed file matches the recording. Needs ffmpeg and ffprobe on
// PATH. Ends with ffprobe's numbers and BACKUP OK, or exits 1.
//
// Retiming: the beat log holds wall-clock seconds, but Playwright's recording can fall behind the
// wall clock (measured: a 5.8 s frozen stretch while the page left the app for the slides). So a
// beat that opened with a page load (nav: true) starts at the first scene cut ffmpeg finds near
// it, and the lag found there carries forward to the later beats; the other beats keep their
// wall-clock times plus that lag.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const WEB = path.resolve(import.meta.dirname, '..');
const ROOT = path.resolve(WEB, '..');
const EVIDENCE_DIR = path.resolve(process.env.EVIDENCE_DIR ?? path.join(WEB, 'evidence'));
const DOCS_SRT = path.join(ROOT, 'docs', 'captions.srt');
const INPUT = 'demo-path.webm';
const BEATS = 'demo-path.json';
const OUT_SRT = 'aftergrip-backup.srt';
const OUTPUT = 'aftergrip-backup.mp4';
const MAX_S = 170;
// Top left of the 3D view (Alignment 5 is top left in the SSA numbering force_style uses for an SRT), clear of the app's own captions (bottom centre) and the console
// (right). Units are libass script pixels for an SRT (384 x 288 scaled to the frame).
const STYLE = 'FontName=Arial,FontSize=10,PrimaryColour=&H00FFFFFF,BackColour=&H90000000,BorderStyle=3,Outline=1,Shadow=0,Alignment=5,MarginL=6,MarginR=86,MarginV=38';

function fail(message) {
  console.error(`BACKUP FAILED: ${message}`);
  process.exit(1);
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: EVIDENCE_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) fail(`${cmd} did not start (${result.error.message}); is it on PATH?`);
  if (result.status !== 0) fail(`${cmd} exited ${result.status}:\n${(result.stderr ?? '').split('\n').slice(-15).join('\n')}`);
  return result.stdout;
}

/** SRT entries in order: text only (the times are replaced). */
function parseSrt(text) {
  return text
    .replace(/\r/g, '')
    .trim()
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.split('\n');
      const timeLine = lines.findIndex((l) => l.includes('-->'));
      if (timeLine < 0) fail(`a caption block has no time line: ${block}`);
      return lines.slice(timeLine + 1).join('\n').trim();
    });
}

function stamp(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

for (const file of [INPUT, BEATS]) {
  if (!existsSync(path.join(EVIDENCE_DIR, file))) fail(`${path.join(EVIDENCE_DIR, file)} is missing: run e2e/demo-path.spec.ts first`);
}
if (!existsSync(DOCS_SRT)) fail(`${DOCS_SRT} is missing`);

const { beats } = JSON.parse(readFileSync(path.join(EVIDENCE_DIR, BEATS), 'utf8'));
const captions = parseSrt(readFileSync(DOCS_SRT, 'utf8'));
if (captions.length !== beats.length) fail(`docs/captions.srt has ${captions.length} captions for ${beats.length} beats`);
if (!captions.some((c) => /simulation/i.test(c))) fail('no caption says "simulation"');
const videoS = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', INPUT]).trim());

/** Scene cuts (seconds) in the recording, from ffmpeg's scene score. */
function sceneCuts() {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-i', INPUT, '-vf', "select='gt(scene,0.08)',showinfo", '-an', '-f', 'null', '-'], { cwd: EVIDENCE_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) fail(`ffmpeg scene detection exited ${result.status}`);
  return [...result.stderr.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1]));
}

const cuts = sceneCuts();
const starts = [];
let lag = 0;
let lastCut = 0;
for (const beat of beats) {
  let start = beat.start_s + lag;
  if (beat.nav) {
    const cut = cuts.find((c) => c > lastCut + 0.5 && c >= beat.start_s - 3 && c <= beat.start_s + 15);
    if (cut === undefined) console.log(`no scene cut found for ${beat.id} near ${beat.start_s} s; using the wall-clock time`);
    else {
      start = cut;
      lastCut = cut;
      lag = Math.max(lag, cut - beat.start_s);
    }
  }
  starts.push(Math.max(0, start));
}
starts[0] = 0;
console.log(`scene cuts ${JSON.stringify(cuts)}; caption starts ${JSON.stringify(starts.map((s) => Number(s.toFixed(2))))}; video ${videoS} s`);
const ends = starts.map((s, i) => (i + 1 < starts.length ? starts[i + 1] - 0.05 : videoS));
const srt = captions.map((text, i) => `${i + 1}\n${stamp(starts[i])} --> ${stamp(ends[i])}\n${text}\n`).join('\n');
writeFileSync(path.join(EVIDENCE_DIR, OUT_SRT), srt);
if (process.argv.includes('--update-docs')) {
  writeFileSync(DOCS_SRT, srt);
  console.log(`retimed captions written to ${DOCS_SRT}`);
}

// Relative names: ffmpeg runs inside EVIDENCE_DIR, so the subtitles filter needs no Windows
// drive-letter escaping.
const filter = `scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,subtitles=${OUT_SRT}:force_style='${STYLE}'`;
run('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-i', INPUT,
  '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
  '-map', '0:v:0', '-map', '1:a:0',
  '-vf', filter,
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '128k',
  '-shortest', '-movflags', '+faststart',
  OUTPUT,
]);

const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', OUTPUT]));
const duration = Number(probe.format.duration);
const video = probe.streams.filter((s) => s.codec_type === 'video');
const audio = probe.streams.filter((s) => s.codec_type === 'audio');
const summary = {
  file: path.join(EVIDENCE_DIR, OUTPUT),
  bytes: statSync(path.join(EVIDENCE_DIR, OUTPUT)).size,
  duration_s: duration,
  video: video.map((s) => `${s.codec_name} ${s.width}x${s.height}`),
  audio: audio.map((s) => s.codec_name),
  captions: captions.length,
};
console.log(JSON.stringify(summary, null, 2));
if (!(duration <= MAX_S)) fail(`duration ${duration} s is over ${MAX_S} s`);
if (video.length !== 1 || audio.length !== 1) fail(`want one video and one audio stream, got ${video.length} and ${audio.length}`);
if (video[0].codec_name !== 'h264' || video[0].width !== 1920 || video[0].height !== 1080) fail(`video is ${summary.video[0]}, want h264 1920x1080`);
if (audio[0].codec_name !== 'aac') fail(`audio is ${audio[0].codec_name}, want aac`);
console.log(`BACKUP OK ${duration.toFixed(1)} s`);
