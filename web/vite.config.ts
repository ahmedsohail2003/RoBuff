import net from 'node:net';
import type { ProxyOptions } from 'vite';
import { defineConfig } from 'vitest/config';

// /api goes to the key server (server/index.mjs; KEY_SERVER_PORT, default 8787). When it is
// not running, the dev and preview servers answer for it: /api/health says { ok: false } and
// the rest answer 503, so the page goes to its offline mode without proxy errors.
const KEY_SERVER_PORT = Number(process.env.KEY_SERVER_PORT ?? 8787);

function keyServerUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: KEY_SERVER_PORT });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(300, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const apiProxy: Record<string, ProxyOptions> = {
  '/api': {
    target: `http://127.0.0.1:${KEY_SERVER_PORT}`,
    async bypass(req, res) {
      if (!res || (await keyServerUp())) return undefined;
      const health = (req.url ?? '').startsWith('/api/health');
      res.writeHead(health ? 200 : 503, { 'content-type': health ? 'application/json' : 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(health ? JSON.stringify({ ok: false, gemini: 'missing', elevenlabs: 'missing', note: 'The key server is not running; this answer is from the Vite server.' }) : 'The key server is not running.');
      return req.url ?? '/';
    },
  },
};

// The default @mujoco/mujoco build is single-threaded, so no COOP/COEP headers are
// needed. Only its /mt build needs SharedArrayBuffer and those headers.
export default defineConfig({
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
  // The bindings locate their .wasm relative to their own file, which pre-bundling breaks.
  // MediaPipe loads its WASM from public/mediapipe (see scripts/vendor-mediapipe.mjs).
  optimizeDeps: { exclude: ['@mujoco/mujoco', '@mediapipe/tasks-vision'] },
  build: { target: 'es2022' },
  // 30 s, not Vitest's 5 s: src/objects/test/generate.test.ts once ran past 5 s while Playwright shared the machine.
  test: { include: ['src/**/*.test.ts'], testTimeout: 30000, hookTimeout: 30000 },
});
