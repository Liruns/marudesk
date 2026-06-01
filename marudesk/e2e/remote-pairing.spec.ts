import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/app';

/**
 * T2 ③ Settings UI (docs/t2-secure-pairing-design.md §4). Proves the Remote-access
 * panel's gating + mount: turning the local server on reveals the unencrypted-LAN
 * warning and the device-pairing section, and turning it off hides them again. The
 * pairing handshake + encryption themselves are proven headlessly by
 * `harness:pair` (no real phone needed here); this guards the renderer wiring.
 */
test('remote: toggling the local server reveals/hides the Wi-Fi warning + device pairing', async () => {
  const { app, page } = await launchApp();
  try {
    // Gear → Settings tab → Remote access category.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Remote access' }).click();
    await expect(page.getByRole('heading', { name: 'Remote access' })).toBeVisible();

    // Off by default → no pairing UI.
    await expect(page.getByRole('button', { name: 'Pair a device' })).toHaveCount(0);

    // Turn the local server on (the first On/Off segmented on this panel).
    await page.getByRole('radio', { name: 'On' }).first().click();

    // The unencrypted-network warning + the device-pairing section appear.
    await expect(
      page.getByText(/any device on your network can reach the bridge/i),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Paired devices' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pair a device' })).toBeVisible();

    // Turning it back off hides them again.
    await page.getByRole('radio', { name: 'Off' }).first().click();
    await expect(page.getByRole('button', { name: 'Pair a device' })).toHaveCount(0);
  } finally {
    await app.close();
  }
});
