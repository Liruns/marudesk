import { caaBase, caaHeaders, resolveProject } from '../oauth/google-code-assist';
import {
  buildUsageAmount,
  type UsageLimit,
  type UsageProvider,
  type UsageReport,
  type UsageWindow,
  type UsageFetchParams,
} from './types';

/**
 * Google Code-Assist (personal-account Gemini, `google-caa`) usage provider
 * (SECOND-PASS item 4; ref gajae `usage/gemini.ts`). The agent already drives
 * this backend through {@link codeAssistFetch} (model.ts `google-caa` case), and
 * the project-bootstrap + base-URL + header helpers are reused here from
 * `oauth/google-code-assist.ts` — so the quota probe is just two POSTs
 * (`v1internal:retrieveUserQuota`, plus the cached `loadCodeAssist` project) and a
 * normalize. Without it google-caa quota is invisible and {@link checkProviderQuota}
 * returns ok unconditionally.
 */

interface QuotaBucket {
  modelId?: string;
  remainingFraction?: number;
  resetTime?: string;
}

interface RetrieveUserQuotaResponse {
  buckets?: QuotaBucket[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseWindow(resetTime: string | undefined): UsageWindow {
  if (!resetTime) return { id: 'quota', label: 'Quota window' };
  const resetsAt = Date.parse(resetTime);
  if (Number.isNaN(resetsAt)) return { id: 'quota', label: 'Quota window' };
  return { id: `reset-${resetsAt}`, label: 'Quota window', resetsAt };
}

async function fetchGoogleCaaUsage(params: UsageFetchParams): Promise<UsageReport | null> {
  if (params.provider !== 'google-caa') return null;
  if (params.credential.type !== 'oauth' || !params.credential.accessToken) return null;
  const token = params.credential.accessToken;
  if (params.credential.expiresAt !== undefined && params.credential.expiresAt <= Date.now()) {
    return null;
  }

  let payload: unknown;
  try {
    const project = await resolveProject(token);
    const res = await fetch(`${caaBase()}/v1internal:retrieveUserQuota`, {
      method: 'POST',
      headers: caaHeaders(token),
      body: JSON.stringify(project ? { project } : {}),
      signal: params.signal,
    });
    if (!res.ok) return null;
    payload = await res.json();
  } catch {
    return null;
  }

  if (!isRecord(payload)) return null;
  const data = payload as RetrieveUserQuotaResponse;
  const buckets = Array.isArray(data.buckets) ? data.buckets : [];

  const limits: UsageLimit[] = buckets.map((bucket, index) => {
    const window = parseWindow(bucket.resetTime);
    const remainingFraction =
      typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction)
        ? Math.min(Math.max(bucket.remainingFraction, 0), 1)
        : undefined;
    const amount = buildUsageAmount({
      percentage: remainingFraction !== undefined ? (1 - remainingFraction) * 100 : undefined,
      unit: 'percent',
    });
    return {
      id: `google-caa:${bucket.modelId ?? 'unknown'}:${window.id ?? index}`,
      label: bucket.modelId ? `Gemini ${bucket.modelId}` : 'Gemini quota',
      scope: { provider: 'google-caa', modelId: bucket.modelId, windowId: window.id },
      window,
      amount,
    };
  });

  return {
    provider: 'google-caa',
    fetchedAt: Date.now(),
    limits,
    raw: payload,
  };
}

export const googleCaaUsageProvider: UsageProvider = {
  id: 'google-caa',
  fetchUsage: fetchGoogleCaaUsage,
  supports(params: UsageFetchParams): boolean {
    return (
      params.provider === 'google-caa' &&
      params.credential.type === 'oauth' &&
      !!params.credential.accessToken
    );
  },
};
