/**
 * User-Agent normalization for the embedded web tabs.
 *
 * Electron's default UA carries two tokens that mark the client as a
 * non-standard browser — the app name (`marudesk/<ver>`) and `Electron/<ver>`:
 *
 *   Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like
 *   Gecko) marudesk/0.0.3 Chrome/148.0.0.0 Electron/42.3.3 Safari/537.36
 *
 * Those tokens trip "unsupported browser" gates, embedded-webview sign-in blocks
 * (e.g. Google's disallowed_useragent), and anti-bot heuristics. We strip ONLY
 * those two tokens so the UA reads as a plain Chrome on this OS.
 *
 * We deliberately KEEP the real `Chrome/<version>` token untouched: the version
 * must stay truthful to the bundled engine (Electron 42 → Chromium 148). Forging
 * a higher Chrome version than the engine actually ships would make sites serve
 * features the engine can't run, breaking pages — so this only removes the
 * Electron/app labels, it never bumps the version number.
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strip the `Electron/<ver>` and `<appName>/<ver>` tokens from `defaultUserAgent`
 * (the value Electron computed for the session), leaving a clean Chrome UA with
 * the real Chromium version intact. Idempotent and tolerant of either token being
 * absent. `appName` is `app.getName()` at the call site.
 */
export function buildWebTabUserAgent(defaultUserAgent: string, appName: string): string {
  let ua = defaultUserAgent;
  if (appName) {
    ua = ua.replace(new RegExp(`\\s*${escapeRegExp(appName)}\\/\\S+`, 'i'), '');
  }
  return ua
    .replace(/\s*Electron\/\S+/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
