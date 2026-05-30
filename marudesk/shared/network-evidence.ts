/**
 * Normalized network evidence for the agent `read_network` tool (roadmap P0.5).
 * Pure (no CDP/Electron imports) so it is unit-testable and shared between main
 * (the gated per-tab buffer in electron/browser/cdp.ts) and any consumer.
 *
 * P0.5 framing is *triage*, not "fix": a failed status (401/500/CORS) is usually
 * caused by backend/infra, so the tool surfaces status + type + failure reason so
 * the agent can classify the cause — it does NOT promise a frontend patch. The
 * response *body* (fetched separately) is where deterministic frontend bugs hide
 * (e.g. a `"10%"` string → NaN), and every body/header egress is scrubbed
 * (shared/scrub.ts) before it reaches the model.
 *
 * Single-event records (no requestWillBeSent assembly): `responseReceived` already
 * carries url/status/headers/mimeType, and `loadingFailed` carries the failure —
 * enough for triage without a correlation map.
 */

export type NetworkRecord = {
  /** CDP request id — the handle for a later `read_network_body` fetch. */
  requestId: string;
  url: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  /** CDP ResourceType (Document/XHR/Fetch/Script/...). */
  resourceType?: string;
  failed?: boolean;
  /** CDP loadingFailed errorText / blockedReason. */
  errorText?: string;
  /** Raw response headers — scrubbed at egress, never here. */
  responseHeaders?: Record<string, string>;
  /** Event time (ms). */
  timestamp: number;
};

function headersOf(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number') out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Turn a CDP `Network.responseReceived` / `Network.loadingFailed` message into a
 * record, or null for anything else. Defensive about its `unknown` params —
 * page-driven data must never crash the relay.
 */
export function extractNetwork(
  method: string,
  params: unknown,
): NetworkRecord | null {
  const p = (params ?? {}) as Record<string, unknown>;
  const requestId = typeof p.requestId === 'string' ? p.requestId : '';
  if (!requestId) return null;
  const ts = Date.now();

  if (method === 'Network.responseReceived') {
    const r = (p.response ?? {}) as Record<string, unknown>;
    return {
      requestId,
      url: typeof r.url === 'string' ? r.url : '',
      status: typeof r.status === 'number' ? r.status : undefined,
      statusText: typeof r.statusText === 'string' ? r.statusText : undefined,
      mimeType: typeof r.mimeType === 'string' ? r.mimeType : undefined,
      resourceType: typeof p.type === 'string' ? p.type : undefined,
      responseHeaders: headersOf(r.headers),
      timestamp: ts,
    };
  }

  if (method === 'Network.loadingFailed') {
    const blocked = typeof p.blockedReason === 'string' ? p.blockedReason : '';
    const err = typeof p.errorText === 'string' ? p.errorText : '';
    return {
      requestId,
      url: '',
      resourceType: typeof p.type === 'string' ? p.type : undefined,
      failed: true,
      errorText: blocked ? `blocked: ${blocked}` : err || 'load failed',
      timestamp: ts,
    };
  }

  return null;
}
