import { defineConfig } from '@playwright/test';

/**
 * e2e config for the Electron app. Tests launch the *built* app
 * (dist-electron/main.mjs + dist/) via Playwright's `_electron`, so run
 * `npm run build` first (the `test:e2e` script does this). Electron needs a
 * display, so this runs headed on a real session; CI would need a virtual
 * display (xvfb-run on Linux) — noted, not configured here.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  // One Electron instance at a time — the app is a singleton-ish desktop app.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
});
