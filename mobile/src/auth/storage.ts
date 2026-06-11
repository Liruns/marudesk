/**
 * Persisted credentials/connection settings.
 *
 * Uses Capacitor `Preferences` (backed by UserDefaults on iOS and
 * SharedPreferences on Android) when running inside a
 * Capacitor WebView, and falls back to `localStorage` for the plain web/PWA dev
 * build where the plugin isn't available. All access is async + best-effort.
 *
 * NOTE: this is "persist for convenience", not a hardware vault. The threat model
 * (relay-side) keeps secrets server-only; the phone only ever holds the JWT pair.
 */

type Loaded = Record<string, string>;
type PreferencesPlugin = typeof import('@capacitor/preferences').Preferences;
type PreferencesHandle = {
  readonly plugin: PreferencesPlugin;
};
type CapacitorRuntime = {
  readonly isNativePlatform?: () => boolean;
  readonly isPluginAvailable?: (pluginName: string) => boolean;
};

const PREFIX = 'marudesk.';

let memo: Loaded | null = null; // last-good cache for synchronous reads

function getCapacitor(): CapacitorRuntime | null {
  const cap: unknown = Reflect.get(globalThis, 'Capacitor');
  return cap && typeof cap === 'object' ? cap : null;
}

/** True when running inside a Capacitor native shell (vs. plain web/PWA). */
function isNative(): boolean {
  const cap = getCapacitor();
  return Boolean(cap?.isNativePlatform?.());
}

function hasPreferencesPlugin(): boolean {
  const cap = getCapacitor();
  const isAvailable = cap?.isPluginAvailable;
  return typeof isAvailable !== 'function' || isAvailable('Preferences');
}

async function prefs(): Promise<PreferencesHandle | null> {
  if (!isNative() || !hasPreferencesPlugin()) return null;
  try {
    const mod = await import('@capacitor/preferences');
    return { plugin: mod.Preferences };
  } catch {
    return null;
  }
}

function localGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(PREFIX + key) ?? memo?.[key] ?? null;
  } catch {
    return memo?.[key] ?? null;
  }
}

function localSet(key: string, value: string): void {
  try {
    if (globalThis.localStorage) {
      globalThis.localStorage.setItem(PREFIX + key, value);
      return;
    }
  } catch {
  }
  (memo ??= {})[key] = value;
}

function localRemove(key: string): void {
  try {
    globalThis.localStorage?.removeItem(PREFIX + key);
  } catch {
  }
  if (memo) delete memo[key];
}

export async function storageGet(key: string): Promise<string | null> {
  const p = await prefs();
  if (p) {
    try {
      const { value } = await p.plugin.get({ key: PREFIX + key });
      return value ?? null;
    } catch {
      return localGet(key);
    }
  }
  return localGet(key);
}

export async function storageSet(key: string, value: string): Promise<void> {
  const p = await prefs();
  if (p) {
    try {
      await p.plugin.set({ key: PREFIX + key, value });
      localRemove(key);
      return;
    } catch {
      localSet(key, value);
      return;
    }
  }
  localSet(key, value);
}

export async function storageRemove(key: string): Promise<void> {
  const p = await prefs();
  if (p) {
    try {
      await p.plugin.remove({ key: PREFIX + key });
      localRemove(key);
      return;
    } catch {
      localRemove(key);
      return;
    }
  }
  localRemove(key);
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
  // Local-only mobile diagnostics flag; never sent to the relay/PC.
  developerMode: 'developerMode',
  // Chat scope + model picks, restored across launches. `chatWorkspace` is a PC
  // workspace id or the literal 'global' (explicitly workspace-less); absent
  // means "follow the PC's active workspace" on the next catalog load.
  chatWorkspace: 'chatWorkspace',
  chatProvider: 'chatProvider',
  chatModel: 'chatModel',
} as const;
