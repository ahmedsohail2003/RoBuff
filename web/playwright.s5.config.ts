import { defineConfig } from '@playwright/test';

// Slice S5's own config: the object specs on their own dev server port, so they never reuse
// or stop another test run's server. Usage: npx playwright test -c playwright.s5.config.ts
const PORT = Number(process.env.S5_PORT ?? 5174);

export default defineConfig({
  testDir: 'e2e',
  testMatch: /s5-.*\.spec\.ts$/,
  timeout: 180_000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 720 },
  },
  webServer: {
    command: `node scripts/vendor-mediapipe.mjs && npx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
