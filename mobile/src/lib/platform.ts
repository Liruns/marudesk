/**
 * Whether this WebView runs inside a Capacitor native shell (vs web/PWA).
 * Read from the global the Capacitor runtime injects — no import needed, so
 * the check is safe in any build, including ones without Capacitor at all.
 */
export function isNativePlatform(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return Boolean(cap?.isNativePlatform?.());
}
