// Copies the MediaPipe vision WASM loader and binary from the pinned npm package into
// public/mediapipe/wasm, so the app serves them itself: no CDN at the venue, and no
// cross-origin request for COEP to block if headers are ever added. Run by postinstall,
// predev, prebuild and the Playwright web server. The copies are git-ignored.
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const to = path.join(root, 'public', 'mediapipe', 'wasm');
const files = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm'];

if (!existsSync(from)) {
  console.error(`vendor-mediapipe: ${from} is missing; run npm install first`);
  process.exit(1);
}
mkdirSync(to, { recursive: true });
for (const name of files) {
  const source = path.join(from, name);
  const target = path.join(to, name);
  if (existsSync(target) && statSync(target).size === statSync(source).size && statSync(target).mtimeMs >= statSync(source).mtimeMs) continue;
  copyFileSync(source, target);
  console.log(`vendor-mediapipe: copied ${name} (${statSync(target).size} bytes)`);
}
