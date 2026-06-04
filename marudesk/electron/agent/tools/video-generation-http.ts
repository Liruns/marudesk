import type { ModelEntry, ProviderId } from '../../../shared/providers';
import type { ModelAuth } from '../model';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const XAI_BASE_URL = 'https://api.x.ai/v1';

export class VideoHttpError extends Error {
  readonly provider: ProviderId;
  readonly status: number;
  readonly body: string;

  constructor(provider: ProviderId, status: number, body: string) {
    const snippet = body.trim().slice(0, 300);
    super(`${provider} video request failed (${status})${snippet ? `: ${snippet}` : ''}`);
    this.name = 'VideoHttpError';
    this.provider = provider;
    this.status = status;
    this.body = snippet;
  }
}

export class VideoTimeoutError extends Error {
  readonly remoteId: string;

  constructor(remoteId: string) {
    super(`video job ${remoteId} did not complete before the wait limit`);
    this.name = 'VideoTimeoutError';
    this.remoteId = remoteId;
  }
}

export function tokenOf(auth: ModelAuth): string {
  return auth.mode === 'oauth' ? auth.accessToken : auth.apiKey;
}

export function baseUrlFor(candidate: ModelEntry, baseUrl: string | undefined): string {
  switch (candidate.videoTransport) {
    case 'openai-videos':
      return OPENAI_BASE_URL;
    case 'openai-compatible-videos':
      if (baseUrl) return baseUrl;
      throw new Error(`provider ${candidate.provider} has no video base URL`);
    case 'xai-videos':
      if (candidate.provider === 'xai') return XAI_BASE_URL;
      if (baseUrl) return baseUrl;
      throw new Error(`provider ${candidate.provider} has no video base URL`);
    default:
      throw new Error(`${candidate.provider}:${candidate.id} is not a video generation model`);
  }
}

export function endpoint(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/+$/g, '')}${pathname}`;
}

async function parseJson(response: Response, provider: ProviderId): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) throw new VideoHttpError(provider, response.status, text);
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`invalid JSON response from ${provider}: ${err.message}`, { cause: err });
    }
    throw err;
  }
}

export async function postJson(input: {
  readonly url: string;
  readonly provider: ProviderId;
  readonly token: string;
  readonly body: Record<string, unknown>;
  readonly signal: AbortSignal;
}): Promise<unknown> {
  const response = await fetch(input.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input.body),
    signal: input.signal,
  });
  return parseJson(response, input.provider);
}

export async function getJson(input: {
  readonly url: string;
  readonly provider: ProviderId;
  readonly token: string;
  readonly signal: AbortSignal;
}): Promise<unknown> {
  const response = await fetch(input.url, {
    headers: { Authorization: `Bearer ${input.token}` },
    signal: input.signal,
  });
  return parseJson(response, input.provider);
}

export async function downloadBinary(input: {
  readonly url: string;
  readonly provider: ProviderId;
  readonly token?: string;
  readonly signal: AbortSignal;
}): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }> {
  const headers = input.token ? { Authorization: `Bearer ${input.token}` } : undefined;
  const response = await fetch(input.url, { headers, signal: input.signal });
  if (!response.ok) {
    const detail = await response.text().catch((err: unknown) => {
      if (err instanceof Error) return err.message;
      return String(err);
    });
    throw new VideoHttpError(input.provider, response.status, detail);
  }
  const mediaType = response.headers.get('content-type') ?? 'video/mp4';
  return { bytes: new Uint8Array(await response.arrayBuffer()), mediaType };
}

export function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
