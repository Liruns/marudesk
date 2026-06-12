import { randomUUID } from 'node:crypto';
import type { FetchFunction } from '@ai-sdk/provider-utils';
import { sleep } from '../../shared/sleep';

/**
 * Google Code-Assist translator (docs/oauth-providers-design.md §10) — EXPERIMENTAL.
 *
 * A personal-account Google OAuth token can't call the public Gemini API; it must
 * go through the gemini-cli "Code Assist" backend (`cloudcode-pa…/v1internal`),
 * which wraps a standard Gemini request in a `{project, model, request}` envelope
 * and wraps the response in `{response}`. We expose this to the agent as a custom
 * `fetch` passed to `@ai-sdk/google`: the SDK builds a normal
 * `…/models/{model}:generateContent` (or `:streamGenerateContent?alt=sse`) request,
 * and this fetch intercepts it, re-targets the Code-Assist backend, wraps/unwraps,
 * and (for streaming) unwraps each SSE chunk — so the SDK sees a standard response.
 *
 * Unverified without a real Google account: the request/response shapes follow
 * gemini-cli + hermes-agent, but the `loadCodeAssist`/`onboardUser` bootstrap and
 * SSE framing may need adjustment against live behavior.
 */

const META = { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' };

/** The Code-Assist base URL, overridable via env for tests / an advanced proxy. */
function caaBase(): string {
  return process.env.MARUDESK_CAA_BASE_URL || 'https://cloudcode-pa.googleapis.com';
}

function caaHeaders(token: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    // Code-Assist may reject unrecognized UAs — mimic gemini-cli's node client.
    'user-agent': 'google-api-nodejs-client/9.15.1 (gzip)',
    'x-goog-api-client': 'gl-node/24.0.0',
    'x-activity-request-id': randomUUID(),
  };
}

async function caaCall<T>(token: string, methodColon: string, body: unknown): Promise<T> {
  const resp = await fetch(`${caaBase()}/v1internal:${methodColon}`, {
    method: 'POST',
    headers: caaHeaders(token),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).slice(0, 300);
    throw new Error(`Code-Assist ${methodColon} HTTP ${resp.status}: ${detail}`);
  }
  return (await resp.json()) as T;
}

type LoadResp = {
  cloudaicompanionProject?: unknown;
  currentTier?: { id?: string };
  allowedTiers?: { id?: string; isDefault?: boolean }[];
};
type Operation = { name?: string; done?: boolean; response?: { cloudaicompanionProject?: unknown } };

function extractProjectString(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.name === 'string') return obj.name;
    if (typeof obj.projectId === 'string') return obj.projectId;
    if (typeof obj.id === 'string') return obj.id;
  }
  return undefined;
}

// The project is account-scoped and stable across token refreshes, so cache a
// SINGLE value — NOT keyed by the (rotating) access token, which would grow
// unbounded and retain dead bearer tokens for the process lifetime. There's one
// google-caa connection at a time; {@link clearCodeAssistProject} drops it on
// connect/disconnect so a different account re-bootstraps.
let cachedProject: string | null = null;

/** Bootstrap the free-tier project (loadCodeAssist → onboardUser LRO), cached. */
async function resolveProject(token: string): Promise<string> {
  if (cachedProject) return cachedProject;

  const load = await caaCall<LoadResp>(token, 'loadCodeAssist', { metadata: META });
  let project = extractProjectString(load.cloudaicompanionProject);

  if (!project) {
    const tierId =
      load.allowedTiers?.find((t) => t.isDefault)?.id ?? load.currentTier?.id ?? 'free-tier';
    const onboardBody = { tierId, metadata: META };
    let op = await caaCall<Operation>(token, 'onboardUser', onboardBody);
    for (let i = 0; i < 12 && !op.done; i++) {
      await sleep(2000);
      op = await caaCall<Operation>(token, 'onboardUser', onboardBody);
    }
    project = extractProjectString(op.response?.cloudaicompanionProject);
  }

  if (!project) {
    throw new Error('Google Code-Assist: could not resolve a project (onboarding incomplete)');
  }
  cachedProject = project;
  return project;
}

/** Drop the cached project (on connect/disconnect of a google-caa account). */
export function clearCodeAssistProject(): void {
  cachedProject = null;
}

function readBodyText(body: RequestInit['body']): string {
  if (body == null) return '{}';
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return String(body);
}

/** Unwrap a Code-Assist SSE stream (`data: {response: chunk}`) into a standard
 * Gemini SSE stream (`data: {chunk}`) the AI SDK can parse. */
function unwrapSse(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = '';
  const emit = (controller: TransformStreamDefaultController<Uint8Array>, line: string): void => {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') return; // Gemini ends on stream close
    try {
      const obj = JSON.parse(payload) as Record<string, unknown>;
      const inner = obj && typeof obj === 'object' && 'response' in obj ? obj.response : obj;
      controller.enqueue(enc.encode(`data: ${JSON.stringify(inner)}\n\n`));
    } catch {
      controller.enqueue(enc.encode(`data: ${payload}\n\n`));
    }
  };
  const ts = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) emit(controller, line);
    },
    flush(controller) {
      if (buf) emit(controller, buf);
    },
  });
  return upstream.pipeThrough(ts);
}

const GEN_RE = /\/models\/([^:/]+):(streamGenerateContent|generateContent)/;

/**
 * A `fetch` for `@ai-sdk/google` that routes its requests through the Code-Assist
 * backend using the given OAuth access token. Returns a function compatible with
 * the SDK's `fetch` option.
 */
export function codeAssistFetch(token: string): FetchFunction {
  const doFetch: FetchFunction = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as { url: string }).url;
    const m = GEN_RE.exec(url);
    if (!m) {
      // Not a generate call we translate — fail loudly rather than leak the token
      // to an unexpected host.
      throw new Error(`Code-Assist: unexpected request ${url}`);
    }
    const model = m[1];
    const stream = m[2] === 'streamGenerateContent';
    const request = JSON.parse(readBodyText(init?.body)) as unknown;
    const project = await resolveProject(token);
    const envelope = { project, model, user_prompt_id: randomUUID(), request };
    const target = `${caaBase()}/v1internal:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;

    const resp = await fetch(target, {
      method: 'POST',
      headers: caaHeaders(token),
      body: JSON.stringify(envelope),
      signal: init?.signal ?? undefined,
    });
    if (!resp.ok) {
      // A 400 with "Invalid value (project)" means the cached project is stale
      // or malformed — drop it so the next request re-bootstraps.
      if (resp.status === 400) cachedProject = null;
      const text = await resp.text().catch(() => '');
      return new Response(text, {
        status: resp.status,
        statusText: resp.statusText,
        headers: { 'content-type': resp.headers.get('content-type') ?? 'application/json' },
      });
    }

    if (!stream) {
      const wrapped = (await resp.json()) as { response?: unknown };
      const inner = wrapped && typeof wrapped === 'object' && 'response' in wrapped ? wrapped.response : wrapped;
      return new Response(JSON.stringify(inner), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (!resp.body) return new Response('', { status: 502 });
    return new Response(unwrapSse(resp.body), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  return doFetch;
}
