import { shell } from 'electron';

/**
 * Hand a URL to the OS only if its scheme is safe to. Web content (and our own
 * window-open / context-menu paths) can request arbitrary URLs; passing those
 * straight to `shell.openExternal` is a known footgun — a page could launch
 * `file://`, a UNC path (`\\\\host\\share`), or a custom app-protocol handler.
 * We allow only the schemes a link legitimately needs to open outside the app.
 */
const SAFE_EXTERNAL_SCHEME = /^(https?|mailto|tel):/i;

/**
 * Open `url` externally iff its scheme is on the safe list; otherwise ignore.
 * Resolves `true` only when the OS actually accepted the handoff — a broken
 * default-browser registration rejects, which callers can surface (the OAuth
 * connect flow leads with its manual fallback link instead of failing silently).
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  if (typeof url !== 'string' || !SAFE_EXTERNAL_SCHEME.test(url)) return false;
  try {
    await shell.openExternal(url);
    return true;
  } catch (err) {
    console.error('[safe-open] shell.openExternal failed:', err);
    return false;
  }
}
