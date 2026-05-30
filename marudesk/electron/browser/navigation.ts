import { getActive } from './state';
import { createAndActivateTab } from './tabs';
import { resolveAddressBarInput, searchBaseFor } from './url';
import { getSettingsSync } from '../settings';

/**
 * Address-bar navigation: resolve raw input to a safe URL (or a web search),
 * then load it in the active web view (opening one if the active tab is a
 * feature tab). The pure resolver lives in `./url` so `tabs.ts` can share it
 * for new-tab loads without a navigation↔tabs cycle.
 */

export { resolveAddressBarInput };

export async function navigateActive(rawUrl: string): Promise<void> {
  const url = resolveAddressBarInput(
    rawUrl,
    searchBaseFor(getSettingsSync().browser.searchEngine),
  );
  if (!url) return;
  const active = getActive();
  // Navigation always targets a web view. If the active tab is a feature tab
  // (or there is none), open a fresh web tab to host the navigation.
  const rec = active && active.view ? active : createAndActivateTab('web');
  if (!rec.view) return;
  await rec.view.webContents.loadURL(url);
}
