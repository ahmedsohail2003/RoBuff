import { defineConfig } from 'vitest/config';

// The default @mujoco/mujoco build is single-threaded, so no COOP/COEP headers are
// needed. Only its /mt build needs SharedArrayBuffer and those headers.
export default defineConfig({
  // The bindings locate their .wasm relative to their own file, which pre-bundling breaks.
  // MediaPipe loads its WASM from public/mediapipe (see scripts/vendor-mediapipe.mjs).
  optimizeDeps: { exclude: ['@mujoco/mujoco', '@mediapipe/tasks-vision'] },
  build: { target: 'es2022' },
  // 30 s, not Vitest's 5 s: src/objects/test/generate.test.ts once ran past 5 s while Playwright shared the machine.
  test: { include: ['src/**/*.test.ts'], testTimeout: 30000, hookTimeout: 30000 },
});
