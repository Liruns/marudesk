import { app, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  isProviderId,
  PROVIDERS,
  type ProviderId,
  type ProviderStatus,
} from '../shared/providers';
import { invalidateModelsCache } from './models';
import { defineHandler } from './ipc/define-handler';
import { str } from './ipc/validate';

const CREDS_FILE = 'marudesk-credentials.enc';

type CredEntry = {
  apiKey?: string;
};

type CredMap = Partial<Record<ProviderId, CredEntry>>;

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
    map[k] = { apiKey };
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

async function listProviders(): Promise<ProviderStatus[]> {
  let map: CredMap = {};
  try {
    map = await loadCreds();
  } catch {
    // If decryption fails, just report all as not having keys.
  }
  return PROVIDERS.map((p) => ({
    id: p.id,
    hasKey: !!map[p.id]?.apiKey,
  }));
}

async function setProviderKey(
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

async function clearProviderKey(provider: ProviderId): Promise<void> {
  const map = await loadCreds().catch(() => ({}) as CredMap);
  if (map[provider]) {
    delete map[provider];
    await saveCreds(map);
  }
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
