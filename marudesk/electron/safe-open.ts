import { shell } from 'electron';

/**
 * Hand a URL to the OS only if its scheme is safe to. Web content (and our own
 * window-open / context-menu paths) can request arbitrary URLs; passing those
 * straight to `shell.openExternal` is a known footgun — a page could launch
 * `file://`, a UNC path (`\\\\host\\share`), or a custom app-protocol handler.
 * We allow only the schemes a link legitimately needs to open outside the app.
 */
const SAFE_EXTERNAL_SCHEME = /^(https?|mailto|tel):/i;

/** Open `url` externally iff its scheme is on the safe list; otherwise ignore. */
export function openExternalUrl(url: string): void {
  if (typeof url === 'string' && SAFE_EXTERNAL_SCHEME.test(url)) {
    void shell.openExternal(url);
  }
}
