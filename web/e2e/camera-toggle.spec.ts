import { chromium, expect, test } from '@playwright/test';

// The console's top-right camera button: from mouse input it turns the webcam on (the page
// reloads with ?input=webcam&autostart=1 and starts the camera without the start screen), and
// from webcam input it goes back to the mouse. Chrome's fake camera stands in for a real one.
const PORT = Number(process.env.E2E_PORT ?? 5199);

test('the camera button turns the webcam on and back to the mouse', async () => {
  test.setTimeout(120_000);
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(`http://127.0.0.1:${PORT}/?input=mouse`);
    const toggle = page.getByTestId('camera-toggle');
    await expect(toggle).toHaveText('Turn on camera', { timeout: 60_000 });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await toggle.click();
    await page.waitForURL(/input=webcam/);
    expect(new URL(page.url()).searchParams.get('autostart')).toBe('1');
    // The camera starts by itself: no start screen, the button shows it is on, the status line says running.
    await expect(page.getByTestId('camera-toggle')).toHaveText('Camera on · use mouse', { timeout: 60_000 });
    await expect(page.locator('#camera-intro')).toHaveCount(0);
    await expect(page.locator('#status')).toContainText('webcam', { timeout: 60_000 });
    await expect(page.locator('#status')).toContainText('running', { timeout: 60_000 });

    await page.getByTestId('camera-toggle').click();
    await page.waitForURL(/input=mouse/);
    expect(new URL(page.url()).searchParams.has('autostart')).toBe(false);
    await expect(page.getByTestId('camera-toggle')).toHaveText('Turn on camera', { timeout: 60_000 });
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
