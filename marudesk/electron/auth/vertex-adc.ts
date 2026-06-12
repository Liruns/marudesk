import { readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const { subtle } = globalThis.crypto;

/* ── credential types ───────────────────────────────────────────────────── */

type ServiceAccountKey = {
  type: 'service_account';
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  token_uri: string;
};

type AuthorizedUser = {
  type: 'authorized_user';
  client_id: string;
  client_secret: string;
  refresh_token: string;
};

type AdcCredential = ServiceAccountKey | AuthorizedUser;

export type { ServiceAccountKey, AuthorizedUser, AdcCredential };

/* ── helpers ────────────────────────────────────────────────────────────── */

function base64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlEncode(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function isServiceAccountKey(obj: Record<string, unknown>): obj is ServiceAccountKey {
  return (
    obj.type === 'service_account' &&
    typeof obj.project_id === 'string' &&
    typeof obj.private_key_id === 'string' &&
    typeof obj.private_key === 'string' &&
    typeof obj.client_email === 'string' &&
    typeof obj.token_uri === 'string'
  );
}

function isAuthorizedUser(obj: Record<string, unknown>): obj is AuthorizedUser {
  return (
    obj.type === 'authorized_user' &&
    typeof obj.client_id === 'string' &&
    typeof obj.client_secret === 'string' &&
    typeof obj.refresh_token === 'string'
  );
}

function isAdcCredential(obj: unknown): obj is AdcCredential {
  if (typeof obj !== 'object' || obj === null) return false;
  const rec = obj as Record<string, unknown>;
  return isServiceAccountKey(rec) || isAuthorizedUser(rec);
}

async function readJsonFile(path: string): Promise<unknown> {
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as unknown;
}

/* ── credential resolution ──────────────────────────────────────────────── */

async function fromEnvVar(): Promise<AdcCredential | null> {
  const envPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!envPath) return null;
  try {
    const parsed = await readJsonFile(envPath);
    return isAdcCredential(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function wellKnownPath(): string {
  if (platform() === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'gcloud', 'application_default_credentials.json');
  }
  return join(homedir(), '.config', 'gcloud', 'application_default_credentials.json');
}

async function fromWellKnown(): Promise<AdcCredential | null> {
  try {
    const parsed = await readJsonFile(wellKnownPath());
    return isAdcCredential(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

type MetadataTokenResponse = {
  access_token: string;
  expires_in: number;
  token_type: string;
};

async function fromMetadataServer(): Promise<string | null> {
  try {
    const resp = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(2000),
      },
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as MetadataTokenResponse;
    if (!json.access_token) return null;
    const expiresIn = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 3600;
    cachedToken = json.access_token;
    cachedExpiresAt = Date.now() + expiresIn * 1000;
    return json.access_token;
  } catch {
    return null;
  }
}

export async function resolveAdcCredential(): Promise<AdcCredential | null> {
  return (await fromEnvVar()) ?? (await fromWellKnown()) ?? null;
}

/* ── JWT signing (service account) ──────────────────────────────────────── */

function pemToDer(pem: string): ArrayBuffer {
  const lines = pem
    .replace(/-----BEGIN [A-Z ]+-----/, '')
    .replace(/-----END [A-Z ]+-----/, '')
    .replace(/\s/g, '');
  const binary = atob(lines);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

async function signJwt(key: ServiceAccountKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: key.token_uri,
    iat: now,
    exp: now + 3600,
  };

  const headerB64 = base64urlEncode(JSON.stringify(header));
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const cryptoKey = await subtle.importKey(
    'pkcs8',
    pemToDer(key.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64url(signature)}`;
}

/* ── token exchange ─────────────────────────────────────────────────────── */

type TokenEndpointResponse = {
  access_token?: string;
  expires_in?: number;
};

async function exchangeJwtForToken(jwt: string, tokenUri: string): Promise<string | null> {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });
  const resp = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!resp.ok) return null;
  const json = (await resp.json()) as TokenEndpointResponse;
  if (!json.access_token) return null;
  const expiresIn = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 3600;
  cachedToken = json.access_token;
  cachedExpiresAt = Date.now() + expiresIn * 1000;
  return json.access_token;
}

async function refreshAuthorizedUser(cred: AuthorizedUser): Promise<string | null> {
  const body = new URLSearchParams({
    client_id: cred.client_id,
    client_secret: cred.client_secret,
    refresh_token: cred.refresh_token,
    grant_type: 'refresh_token',
  });
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!resp.ok) return null;
  const json = (await resp.json()) as TokenEndpointResponse;
  if (!json.access_token) return null;
  const expiresIn = typeof json.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 3600;
  cachedToken = json.access_token;
  cachedExpiresAt = Date.now() + expiresIn * 1000;
  return json.access_token;
}

/* ── token cache + dedup ────────────────────────────────────────────────── */

const REFRESH_SKEW_MS = 60_000;

let cachedToken: string | null = null;
let cachedExpiresAt = 0;
let inflightRequest: Promise<string | null> | null = null;

async function acquireToken(): Promise<string | null> {
  const cred = await resolveAdcCredential();
  if (cred) {
    if (cred.type === 'service_account') {
      const jwt = await signJwt(cred);
      return exchangeJwtForToken(jwt, cred.token_uri);
    }
    return refreshAuthorizedUser(cred);
  }
  return fromMetadataServer();
}

export async function getVertexAccessToken(): Promise<string | null> {
  if (cachedToken && Date.now() < cachedExpiresAt - REFRESH_SKEW_MS) {
    return cachedToken;
  }

  if (inflightRequest) return inflightRequest;

  inflightRequest = acquireToken().finally(() => {
    inflightRequest = null;
  });
  return inflightRequest;
}

export function resetVertexTokenCache(): void {
  cachedToken = null;
  cachedExpiresAt = 0;
  inflightRequest = null;
}
