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
  // The pure screenshot harness (screens.spec.ts) has no assertions — it can
  // never fail, so it doesn't belong in the green gate. It's excluded by
  // default; the `npm run screens` script sets RUN_SCREENS=1 to opt it back in
  // on demand. chat-visual.spec.ts has real expect() assertions and stays in
  // the gate.
  testIgnore: process.env.RUN_SCREENS ? [] : ['**/screens.spec.ts'],
  timeout: 30_000,
  expect: { timeout: 8_000 },
  // One Electron instance at a time — the app is a singleton-ish desktop app.
  fullyParallel: false,
  workers: 1,
  // Tolerate transient Electron launch/GPU/compositor hiccups on this
  // launch-heavy desktop suite. A deterministic bug fails every attempt and
  // still reds; only genuinely flaky one-offs are masked.
  retries: process.env.CI ? 2 : 1,
  reporter: [['list']],
});
