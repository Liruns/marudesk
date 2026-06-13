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

    // Turn remote access on (scope to its named radiogroup so the assertion is
    // robust to other On/Off toggles — e.g. Auto tunnel — on this panel).
    const remoteAccess = page.getByRole('radiogroup', { name: 'Remote device access' });
    await remoteAccess.getByRole('radio', { name: 'On' }).click();

    // The QR-pairing flow is the hero: the "Pair a device" card + button show
    // immediately (no port/URL clutter to wade through first).
    await expect(page.getByRole('heading', { name: 'Pair a device' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pair a device' })).toBeVisible();

    // Port / network addresses / unattended now live behind an Advanced disclosure
    // so they don't front the panel. Expand it to reach them.
    await expect(page.getByText('Skip approvals (unattended)')).toHaveCount(0);
    await page.getByRole('button', { name: /Advanced .*port/i }).click();

    // The unencrypted-network warning + the unattended toggle are revealed.
    await expect(
      page.getByText(/any device on your network can reach the bridge/i),
    ).toBeVisible();
    await expect(page.getByText('Skip approvals (unattended)')).toBeVisible();

    // Turning unattended on shows its security warning. Target the named
    // radiogroup directly rather than a positional index.
    await page
      .getByRole('radiogroup', { name: 'Skip approvals (unattended)' })
      .getByRole('radio', { name: 'On' })
      .click();
    await expect(page.getByText(/Unattended is on/i)).toBeVisible();

    // Turning remote access back off hides the warning + pairing UI again.
    await remoteAccess.getByRole('radio', { name: 'Off' }).click();
    await expect(page.getByRole('button', { name: 'Pair a device' })).toHaveCount(0);
    await expect(page.getByText(/Unattended is on/i)).toHaveCount(0);
  } finally {
    await app.close();
  }
});
