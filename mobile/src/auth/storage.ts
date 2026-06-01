/**
 * Persisted credentials/connection settings.
 *
 * Uses Capacitor `Preferences` (which on a native build is backed by the OS
 * secure store on iOS / SharedPreferences on Android) when running inside a
 * Capacitor WebView, and falls back to `localStorage` for the plain web/PWA dev
 * build where the plugin isn't available. All access is async + best-effort.
 *
 * NOTE: this is "persist for convenience", not a hardware vault. The threat model
 * (relay-side) keeps secrets server-only; the phone only ever holds the JWT pair.
 */

type Loaded = Record<string, string>;

const PREFIX = 'marudesk.';

let memo: Loaded | null = null; // last-good cache for synchronous reads

/** True when running inside a Capacitor native shell (vs. plain web/PWA). */
function isNative(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return Boolean(cap?.isNativePlatform?.());
}

async function prefs(): Promise<typeof import('@capacitor/preferences').Preferences | null> {
  if (!isNative()) return null;
  try {
    const mod = await import('@capacitor/preferences');
    return mod.Preferences;
  } catch {
    return null;
  }
}

export async function storageGet(key: string): Promise<string | null> {
  const p = await prefs();
  if (p) {
    const { value } = await p.get({ key: PREFIX + key });
    return value ?? null;
  }
  try {
    return globalThis.localStorage?.getItem(PREFIX + key) ?? null;
  } catch {
    return memo?.[key] ?? null;
  }
}

export async function storageSet(key: string, value: string): Promise<void> {
  const p = await prefs();
  if (p) {
    await p.set({ key: PREFIX + key, value });
    return;
  }
  try {
    globalThis.localStorage?.setItem(PREFIX + key, value);
  } catch {
    (memo ??= {})[key] = value;
  }
}

export async function storageRemove(key: string): Promise<void> {
  const p = await prefs();
  if (p) {
    await p.remove({ key: PREFIX + key });
    return;
  }
  try {
    globalThis.localStorage?.removeItem(PREFIX + key);
  } catch {
    if (memo) delete memo[key];
  }
}

/* ── typed keys ──────────────────────────────────────────────────────────── */

export const StorageKeys = {
  relayUrl: 'relayUrl',
  accessToken: 'accessToken',
  refreshToken: 'refreshToken',
  account: 'account', // JSON of RelayAccount
  // T2 direct (paired) mode — the PC base URL + device id + b64url session key.
  directBaseUrl: 'directBaseUrl',
  directDeviceId: 'directDeviceId',
  directKey: 'directKey',
} as const;
