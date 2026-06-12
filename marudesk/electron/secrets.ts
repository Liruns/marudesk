import { app, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  isProviderId,
  PROVIDERS,
  type OAuthTokens,
  type ProviderId,
  type ProviderStatus,
} from '../shared/providers';
import type { RelayAccount } from '../shared/remote';
import { invalidateModelsCache } from './models';
import { defineHandler } from './ipc/define-handler';
import { str } from './ipc/validate';

const CREDS_FILE = 'marudesk-credentials.enc';

type CredEntry = {
  apiKey?: string;
  /** OAuth subscription tokens (Claude Pro/Max) — docs/oauth-providers-design.md. */
  oauth?: OAuthTokens;
  /** Additional OAuth slots for multi-account rotation. The primary slot is
   * `oauth`; extras are appended here and rotated when the primary is
   * rate-limited or exhausted. */
  oauthSlots?: OAuthTokens[];
};

type CredMap = Partial<Record<ProviderId, CredEntry>>;

/** Validate a stored OAuth blob back into {@link OAuthTokens} (trust nothing on disk). */
function coerceOAuth(value: unknown): OAuthTokens | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.accessToken !== 'string' || v.accessToken.length === 0) return undefined;
  if (typeof v.refreshToken !== 'string' || v.refreshToken.length === 0) return undefined;
  if (typeof v.expiresAt !== 'number' || !Number.isFinite(v.expiresAt)) return undefined;
  return {
    accessToken: v.accessToken,
    refreshToken: v.refreshToken,
    expiresAt: v.expiresAt,
    scope: typeof v.scope === 'string' ? v.scope : undefined,
  };
}

function credsFilePath(): string {
  return path.join(app.getPath('userData'), CREDS_FILE);
}

async function loadCreds(): Promise<CredMap> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(credsFilePath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  if (buf.length === 0) return {};
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'safeStorage encryption unavailable; cannot read stored credentials',
    );
  }
  let raw: string;
  try {
    raw = safeStorage.decryptString(buf);
  } catch (err) {
    throw new Error(
      `failed to decrypt stored credentials: ${(err as Error).message}`,
      { cause: err },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const map: CredMap = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isProviderId(k)) continue;
    if (!v || typeof v !== 'object') continue;
    const entry = v as Record<string, unknown>;
    const apiKey =
      typeof entry.apiKey === 'string' && entry.apiKey.length > 0
        ? entry.apiKey
        : undefined;
    const oauthSlots = Array.isArray(entry.oauthSlots)
      ? (entry.oauthSlots as unknown[]).map(coerceOAuth).filter((t): t is OAuthTokens => !!t)
      : undefined;
    map[k] = { apiKey, oauth: coerceOAuth(entry.oauth), ...(oauthSlots?.length ? { oauthSlots } : {}) };
  }
  return map;
}

async function saveCreds(map: CredMap): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'safeStorage encryption unavailable; refuse to write plaintext credentials',
    );
  }
  const file = credsFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const text = JSON.stringify(map);
  const enc = safeStorage.encryptString(text);
  await fs.writeFile(file, enc, { mode: 0o600 });
}

export async function getProviderApiKey(
  provider: ProviderId,
): Promise<string | null> {
  const map = await loadCreds();
  const entry = map[provider];
  return entry?.apiKey ?? null;
}

/** Whether a usable API key is stored for this provider (read-only, never throws). */
export async function hasProviderKey(provider: ProviderId): Promise<boolean> {
  try {
    return !!(await getProviderApiKey(provider));
  } catch {
    return false;
  }
}

/**
 * Connection status for every built-in provider (key stored / OAuth stored /
 * keyless). Backs the `secrets:list-providers` IPC and the bridge's
 * `GET /agent/models` catalog (electron/server/extras.ts).
 */
export async function listProviders(): Promise<ProviderStatus[]> {
  let map: CredMap = {};
  try {
    map = await loadCreds();
  } catch {
    // If decryption fails, just report all as not having keys.
  }
  return PROVIDERS.map((p) => ({
    id: p.id,
    // Keyless (local) providers are always ready — no key to store.
    hasKey: !!p.keyless || !!map[p.id]?.apiKey,
    // OAuth subscription connection (only meaningful for oauth-capable providers).
    oauth: !!p.oauth && !!map[p.id]?.oauth,
  }));
}

export async function setProviderKey(
  provider: ProviderId,
  key: string,
): Promise<void> {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    throw new Error('key must not be empty');
  }
  const map = await loadCreds().catch(() => ({}) as CredMap);
  map[provider] = { ...(map[provider] ?? {}), apiKey: trimmed };
  await saveCreds(map);
}

export async function clearProviderKey(provider: ProviderId): Promise<void> {
  const map = await loadCreds().catch(() => ({}) as CredMap);
  const entry = map[provider];
  if (!entry?.apiKey) return;
  // Clear only the API key — a stored OAuth connection on the same provider must
  // survive "Remove key" (and vice-versa). Drop the whole entry once it's empty.
  if (entry.oauth) map[provider] = { oauth: entry.oauth };
  else delete map[provider];
  await saveCreds(map);
}

/* ── OAuth subscription tokens (docs/oauth-providers-design.md) ──────────── */

export async function getProviderOAuth(
  provider: ProviderId,
): Promise<OAuthTokens | null> {
  const map = await loadCreds();
  return map[provider]?.oauth ?? null;
}

/** Whether an OAuth connection is stored for this provider (never throws). */
export async function hasProviderOAuth(provider: ProviderId): Promise<boolean> {
  try {
    return !!(await getProviderOAuth(provider));
  } catch {
    return false;
  }
}

export async function setProviderOAuth(
  provider: ProviderId,
  tokens: OAuthTokens,
): Promise<void> {
  const map = await loadCreds().catch(() => ({}) as CredMap);
  map[provider] = { ...(map[provider] ?? {}), oauth: tokens };
  await saveCreds(map);
}

export async function clearProviderOAuth(provider: ProviderId): Promise<void> {
  const map = await loadCreds().catch(() => ({}) as CredMap);
  const entry = map[provider];
  if (!entry?.oauth && !entry?.oauthSlots?.length) return;
  // Clear both the primary OAuth slot and any rotation slots.
  if (entry.apiKey) map[provider] = { apiKey: entry.apiKey };
  else delete map[provider];
  await saveCreds(map);
}

/* ── Multi-credential rotation helpers ─────────────────────────────────── */

export async function getAllProviderOAuth(
  provider: ProviderId,
): Promise<OAuthTokens[]> {
  const map = await loadCreds();
  const entry = map[provider];
  const slots: OAuthTokens[] = [];
  if (entry?.oauth) slots.push(entry.oauth);
  if (entry?.oauthSlots) slots.push(...entry.oauthSlots);
  return slots;
}

export async function addProviderOAuthSlot(
  provider: ProviderId,
  tokens: OAuthTokens,
): Promise<void> {
  const map = await loadCreds().catch(() => ({}) as CredMap);
  const entry = map[provider] ?? {};
  if (!entry.oauth) {
    entry.oauth = tokens;
  } else {
    const slots = entry.oauthSlots ?? [];
    slots.push(tokens);
    entry.oauthSlots = slots;
  }
  map[provider] = entry;
  await saveCreds(map);
}

export async function rotateProviderOAuth(provider: ProviderId): Promise<OAuthTokens | null> {
  const map = await loadCreds().catch(() => ({}) as CredMap);
  const entry = map[provider];
  if (!entry?.oauth) return null;
  const slots = entry.oauthSlots ?? [];
  if (slots.length === 0) return null;
  const [next, ...rest] = slots;
  entry.oauthSlots = [...rest, entry.oauth];
  entry.oauth = next;
  map[provider] = entry;
  await saveCreds(map);
  return next;
}

/* ── bridge-server token (docs/remote-mobile-bridge-design §M4) ──────────── */

// The headless bridge server's bearer secret, stored safeStorage-encrypted like
// the provider credentials but in its own file (it isn't provider-keyed). Read
// back defensively (trust nothing on disk). Never logged or sent to the renderer.
const SERVER_TOKEN_FILE = 'marudesk-server-token.enc';

function serverTokenFilePath(): string {
  return path.join(app.getPath('userData'), SERVER_TOKEN_FILE);
}

/** The persisted bridge-server token, or null if none is stored yet. */
export async function getServerTokenStored(): Promise<string | null> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(serverTokenFilePath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (buf.length === 0) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption unavailable; cannot read the server token');
  }
  const token = safeStorage.decryptString(buf);
  return token.length > 0 ? token : null;
}

/** Persist the bridge-server token (safeStorage-encrypted, 0600). */
export async function setServerTokenStored(token: string): Promise<void> {
  if (token.length === 0) throw new Error('refuse to store an empty server token');
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption unavailable; refuse to write a plaintext server token');
  }
  const file = serverTokenFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, safeStorage.encryptString(token), { mode: 0o600 });
}

/* ── cloud-relay session (docs/bridge-model-b-design.md §B2/§3) ──────────────── */

// The PC's cloud-account session for the relay: the relay base URL plus the
// account's JWTs and public account. Stored safeStorage-encrypted in its own file
// (the access/refresh tokens are bearer credentials — same handling as provider
// secrets). NEVER returned to the renderer in plaintext: only a sanitized
// `{ account, connected }` status crosses IPC (see electron/server/relay.ts).
const RELAY_SESSION_FILE = 'marudesk-relay-session.enc';

/** The persisted relay session shape (validated on read — trust nothing on disk). */
export type RelaySession = {
  relayUrl: string;
  accessToken: string;
  refreshToken: string;
  account: RelayAccount;
};

function relaySessionFilePath(): string {
  return path.join(app.getPath('userData'), RELAY_SESSION_FILE);
}

/** Coerce a stored blob back into a {@link RelaySession}, or null if malformed. */
function coerceRelaySession(value: unknown): RelaySession | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.relayUrl !== 'string' || v.relayUrl.length === 0) return null;
  if (typeof v.accessToken !== 'string' || v.accessToken.length === 0) return null;
  if (typeof v.refreshToken !== 'string' || v.refreshToken.length === 0) return null;
  const acc = v.account as Record<string, unknown> | undefined;
  if (!acc || typeof acc !== 'object') return null;
  if (
    typeof acc.id !== 'string' ||
    typeof acc.email !== 'string' ||
    typeof acc.createdAt !== 'string' ||
    (acc.method !== 'local' && acc.method !== 'google' && acc.method !== 'github')
  ) {
    return null;
  }
  const account: RelayAccount = {
    id: acc.id,
    method: acc.method,
    email: acc.email,
    createdAt: acc.createdAt,
    ...(typeof acc.displayName === 'string' ? { displayName: acc.displayName } : {}),
  };
  return { relayUrl: v.relayUrl, accessToken: v.accessToken, refreshToken: v.refreshToken, account };
}

/** The stored relay session, or null if none/undecryptable. Never throws. */
export async function getRelaySession(): Promise<RelaySession | null> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(relaySessionFilePath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
  if (buf.length === 0) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return coerceRelaySession(JSON.parse(safeStorage.decryptString(buf)));
  } catch {
    return null;
  }
}

/** Persist the relay session (safeStorage-encrypted, 0600). */
export async function setRelaySession(session: RelaySession): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption unavailable; refuse to write a plaintext relay session');
  }
  const file = relaySessionFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, safeStorage.encryptString(JSON.stringify(session)), { mode: 0o600 });
}

/** Update just the tokens of the stored session (after a refresh). No-op if none stored. */
export async function updateRelayTokens(
  accessToken: string,
  refreshToken: string,
): Promise<void> {
  const session = await getRelaySession();
  if (!session) return;
  await setRelaySession({ ...session, accessToken, refreshToken });
}

/** Forget the stored relay session (logout / disconnect). Best-effort. */
export async function clearRelaySession(): Promise<void> {
  try {
    await fs.unlink(relaySessionFilePath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/* ── paired device records (T2 ③ — docs/t2-secure-pairing-design.md §2) ────── */

// Phones paired for the direct LAN/Tailscale bridge. Each record holds the E2E
// session key (32-byte AES key, b64url) — a bearer-equivalent secret — so the whole
// list is safeStorage-encrypted in its own file, 0600, and NEVER returned to the
// renderer (only the sanitized PairedDeviceInfo crosses IPC). Coerced on read.
const DEVICES_FILE = 'marudesk-devices.enc';

export type StoredDevice = {
  deviceId: string;
  name: string;
  /** b64url(raw X25519 public key) — identification / fingerprint only. */
  phPub: string;
  /** b64url(32-byte AES-GCM session key) — the E2E secret. */
  key: string;
  fingerprint: string;
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp of last request, or null if not seen since pairing. */
  lastSeenAt: string | null;
};

function devicesFilePath(): string {
  return path.join(app.getPath('userData'), DEVICES_FILE);
}

function coerceDevice(value: unknown): StoredDevice | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.deviceId !== 'string' || v.deviceId.length === 0) return null;
  if (typeof v.key !== 'string' || v.key.length === 0) return null;
  if (typeof v.phPub !== 'string' || typeof v.fingerprint !== 'string') return null;
  if (typeof v.name !== 'string' || typeof v.createdAt !== 'string') return null;
  return {
    deviceId: v.deviceId,
    name: v.name,
    phPub: v.phPub,
    key: v.key,
    fingerprint: v.fingerprint,
    createdAt: v.createdAt,
    lastSeenAt: typeof v.lastSeenAt === 'string' ? v.lastSeenAt : null,
  };
}

/** The persisted paired-device list, or [] if none/undecryptable. Never throws. */
export async function getPairedDevicesStored(): Promise<StoredDevice[]> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(devicesFilePath());
  } catch {
    return [];
  }
  if (buf.length === 0 || !safeStorage.isEncryptionAvailable()) return [];
  try {
    const parsed = JSON.parse(safeStorage.decryptString(buf)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(coerceDevice).filter((d): d is StoredDevice => d !== null);
  } catch {
    return [];
  }
}

/** Persist the paired-device list (safeStorage-encrypted, 0600). */
export async function setPairedDevicesStored(devices: StoredDevice[]): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage encryption unavailable; refuse to write plaintext device keys');
  }
  const file = devicesFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, safeStorage.encryptString(JSON.stringify(devices)), { mode: 0o600 });
}

export function registerSecretsHandlers(): void {
  defineHandler('secrets:list-providers', () => listProviders());

  defineHandler('secrets:set-provider-key', async ([provider, key]) => {
    if (!isProviderId(provider)) throw new Error('invalid provider');
    await setProviderKey(provider, str(key, 'key'));
    invalidateModelsCache(provider);
    return true;
  });

  defineHandler('secrets:clear-provider-key', async ([provider]) => {
    if (!isProviderId(provider)) throw new Error('invalid provider');
    await clearProviderKey(provider);
    invalidateModelsCache(provider);
    return true;
  });
}
