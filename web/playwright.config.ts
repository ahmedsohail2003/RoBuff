import path from 'node:path';
import { defineConfig } from '@playwright/test';

// Each agent or verifier sets its own port, so several test runs can start servers at once.
const PORT = Number(process.env.E2E_PORT ?? 5199);
// Specs write screenshots and reports here: web/evidence (git-ignored) unless EVIDENCE_DIR is set.
// Set here so the config and every worker agree on one absolute folder.
process.env.EVIDENCE_DIR = path.resolve(process.env.EVIDENCE_DIR ?? path.join(import.meta.dirname, 'evidence'));
// E2E_SERVER=preview tests the bundled test build. The default is the dev server.
const usePreview = process.env.E2E_SERVER === 'preview';
const server = usePreview
  ? 'npm run build:test && npx vite preview --outDir dist-test'
  : 'node scripts/vendor-mediapipe.mjs && npx vite';
// E2E_WEBGL=software forces the SwiftShader rasterizer, as on a machine without a GPU.
// By default Chrome picks the adapter; the test reports which one it got.
const webglArgs = process.env.E2E_WEBGL === 'software' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [];

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 720 },
    launchOptions: { args: webglArgs },
  },
  webServer: {
    command: `${server} --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
