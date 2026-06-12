import { createHmac, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export type AwsRegion = string;

export type SignedRequest = {
  url: string;
  headers: Record<string, string>;
  body?: string;
};

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

function parseIniFile(content: string, profile: string): Record<string, string> {
  const result: Record<string, string> = {};
  let inProfile = false;
  const profileHeaders = [
    `[${profile}]`,
    `[profile ${profile}]`,
  ];

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inProfile = profileHeaders.includes(line);
      continue;
    }
    if (!inProfile) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key && value) result[key] = value;
  }

  return result;
}

export async function resolveAwsCredentials(): Promise<AwsCredentials | null> {
  const accessKeyId = process.env['AWS_ACCESS_KEY_ID'];
  const secretAccessKey = process.env['AWS_SECRET_ACCESS_KEY'];

  if (accessKeyId && secretAccessKey) {
    return {
      accessKeyId,
      secretAccessKey,
      sessionToken: process.env['AWS_SESSION_TOKEN'] ?? undefined,
    };
  }

  const credPath = path.join(homedir(), '.aws', 'credentials');
  let content: string;
  try {
    content = await fs.readFile(credPath, 'utf-8');
  } catch {
    return null;
  }

  const profile = process.env['AWS_PROFILE'] ?? 'default';
  const section = parseIniFile(content, profile);

  const ak = section['aws_access_key_id'];
  const sk = section['aws_secret_access_key'];
  if (!ak || !sk) return null;

  return {
    accessKeyId: ak,
    secretAccessKey: sk,
    sessionToken: section['aws_session_token'] ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Region resolution
// ---------------------------------------------------------------------------

export function resolveAwsRegion(): string {
  return process.env['AWS_REGION']
    ?? process.env['AWS_DEFAULT_REGION']
    ?? 'us-east-1';
}

// ---------------------------------------------------------------------------
// SigV4 signing primitives
// ---------------------------------------------------------------------------

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function toAmzDate(date: Date): { datetime: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return {
    datetime: iso,
    dateStamp: iso.slice(0, 8),
  };
}

function buildCanonicalQueryString(searchParams: URLSearchParams): string {
  const pairs: string[] = [];
  searchParams.sort();
  searchParams.forEach((value, key) => {
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  });
  return pairs.join('&');
}

function buildCanonicalHeaders(
  headers: Record<string, string>,
): { canonicalHeaders: string; signedHeaders: string } {
  const entries = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim()] as const)
    .sort(([a], [b]) => a.localeCompare(b));

  const canonicalHeaders = entries.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = entries.map(([k]) => k).join(';');
  return { canonicalHeaders, signedHeaders };
}

function signingKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmacSha256(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

// ---------------------------------------------------------------------------
// signRequest
// ---------------------------------------------------------------------------

export async function signRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | undefined,
  credentials: AwsCredentials,
  region: string,
  service: string,
): Promise<SignedRequest> {
  const parsed = new URL(url);
  const now = new Date();
  const { datetime, dateStamp } = toAmzDate(now);

  const payloadHash = sha256(body ?? '');

  const reqHeaders: Record<string, string> = {
    ...headers,
    host: parsed.host,
    'x-amz-date': datetime,
    'x-amz-content-sha256': payloadHash,
  };

  if (credentials.sessionToken) {
    reqHeaders['x-amz-security-token'] = credentials.sessionToken;
  }

  const canonicalPath =
    parsed.pathname === '' ? '/' : parsed.pathname
      .split('/')
      .map((seg) => encodeURIComponent(decodeURIComponent(seg)))
      .join('/');

  const canonicalQueryString = buildCanonicalQueryString(parsed.searchParams);
  const { canonicalHeaders, signedHeaders } = buildCanonicalHeaders(reqHeaders);

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalPath,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    datetime,
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n');

  const key = signingKey(credentials.secretAccessKey, dateStamp, region, service);
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  reqHeaders['Authorization'] = authorization;

  // Remove host — fetch/http clients set it automatically.
  delete reqHeaders['host'];

  return {
    url,
    headers: reqHeaders,
    body,
  };
}

// ---------------------------------------------------------------------------
// Bedrock helpers
// ---------------------------------------------------------------------------

export function bedrockEndpoint(region: string): string {
  return `https://bedrock-runtime.${region}.amazonaws.com`;
}

export async function signBedrockRequest(
  method: string,
  urlPath: string,
  body: string | undefined,
  credentials: AwsCredentials,
  region: string,
): Promise<SignedRequest> {
  const base = bedrockEndpoint(region);
  const url = `${base}${urlPath}`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  return signRequest(method, url, headers, body, credentials, region, 'bedrock');
}
