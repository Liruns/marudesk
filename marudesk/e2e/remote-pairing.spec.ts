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

    // Turn phone access on (the first On/Off segmented on this panel).
    await page.getByRole('radio', { name: 'On' }).first().click();

    // The QR-pairing flow is the hero: the "Pair your phone" card + button show
    // immediately (no port/URL clutter to wade through first).
    await expect(page.getByRole('heading', { name: 'Pair your phone' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pair a device' })).toBeVisible();

    // Port / network addresses / unattended now live behind an Advanced disclosure
    // so they don't front the panel. Expand it to reach them.
    await expect(page.getByText('Skip approvals (unattended)')).toHaveCount(0);
    await page.getByRole('button', { name: /Advanced — port/i }).click();

    // The unencrypted-network warning + the unattended toggle are revealed.
    await expect(
      page.getByText(/any device on your network can reach the bridge/i),
    ).toBeVisible();
    await expect(page.getByText('Skip approvals (unattended)')).toBeVisible();

    // Turning unattended on shows its security warning. Order of On/Off radios with
    // Advanced open: 1) phone access, 2) skip-approvals, 3) cloud relay.
    await page.getByRole('radio', { name: 'On' }).nth(1).click();
    await expect(page.getByText(/Unattended is on/i)).toBeVisible();

    // Turning phone access back off hides the warning + pairing UI again.
    await page.getByRole('radio', { name: 'Off' }).first().click();
    await expect(page.getByRole('button', { name: 'Pair a device' })).toHaveCount(0);
    await expect(page.getByText(/Unattended is on/i)).toHaveCount(0);
  } finally {
    await app.close();
  }
});
