import { chatgptAccountId } from '../oauth/jwt';
import { OPENAI_CODEX_BASE_URL } from '../oauth/config';
import {
  buildUsageAmount,
  getUsageStatus,
  type UsageFetchParams,
  type UsageLimit,
  type UsageProvider,
  type UsageReport,
} from './types';

/**
 * OpenAI ChatGPT (Codex backend) usage provider (SECOND-PASS item 4; ref gajae
 * `usage/openai-codex.ts`). The Codex OAuth token already drives the agent path
 * (model.ts), so the quota endpoint is a clean fit: it's the same ChatGPT
 * backend, authed with the same Bearer + `chatgpt-account-id` header.
 *
 * Endpoint: `<backend-api>/wham/usage` (the agent uses `<backend-api>/codex`).
 * Without this provider the gauge shows "no data" and {@link checkProviderQuota}
 * returns ok unconditionally, so a spent Codex quota never triggers failover.
 */

/** Derive the `…/backend-api` root from the agent's `…/backend-api/codex` base. */
function codexUsageBase(): string {
  // OPENAI_CODEX_BASE_URL = https://chatgpt.com/backend-api/codex → strip /codex.
  return OPENAI_CODEX_BASE_URL.replace(/\/codex\/?$/, '');
}

interface CodexUsageWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
}

interface CodexRateLimit {
  limit_reached?: boolean;
  primary_window?: CodexUsageWindow | null;
  secondary_window?: CodexUsageWindow | null;
}

interface CodexUsagePayload {
  plan_type?: string;
  rate_limit?: CodexRateLimit | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function resolveResetAt(window: CodexUsageWindow, nowMs: number): number | undefined {
  const resetAt = toNumber(window.reset_at);
  if (resetAt !== undefined) {
    // Heuristic ms-vs-seconds: a value below ~1e12 is seconds since epoch.
    return resetAt > 1_000_000_000_000 ? resetAt : resetAt * 1000;
  }
  const after = toNumber(window.reset_after_seconds);
  if (after !== undefined) return nowMs + after * 1000;
  return undefined;
}

function windowLabel(seconds: number | undefined, fallback: string): { id: string; label: string; durationMs?: number } {
  if (seconds === undefined || seconds <= 0) return { id: fallback, label: fallback };
  const daySeconds = 86_400;
  if (seconds >= daySeconds) {
    const days = Math.round(seconds / daySeconds);
    const label = `${days} ${days === 1 ? 'day' : 'days'}`;
    return { id: `${days}d`, label, durationMs: seconds * 1000 };
  }
  const hours = Math.max(1, Math.round(seconds / 3600));
  const label = `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return { id: `${hours}h`, label, durationMs: seconds * 1000 };
}

function buildLimit(
  key: 'primary' | 'secondary',
  window: CodexUsageWindow,
  accountId: string | null,
  planType: string | undefined,
  limitReached: boolean | undefined,
  nowMs: number,
): UsageLimit {
  const usedPercent = toNumber(window.used_percent);
  const { id, label, durationMs } = windowLabel(
    toNumber(window.limit_window_seconds),
    key === 'primary' ? 'Primary window' : 'Secondary window',
  );
  const resetsAt = resolveResetAt(window, nowMs);
  const amount = buildUsageAmount({
    percentage: usedPercent !== undefined ? Math.min(Math.max(usedPercent, 0), 100) : undefined,
    unit: 'percent',
  });
  const status = limitReached ? 'exhausted' : getUsageStatus(amount.usedFraction);
  return {
    id: `openai-codex:${key}`,
    label,
    scope: {
      provider: 'openai-codex',
      accountId: accountId ?? undefined,
      tier: planType,
      windowId: id,
      shared: true,
    },
    window: { id, label, durationMs, resetsAt },
    amount,
    status,
  };
}

async function fetchCodexUsage(params: UsageFetchParams): Promise<UsageReport | null> {
  if (params.provider !== 'openai-codex') return null;
  if (params.credential.type !== 'oauth' || !params.credential.accessToken) return null;
  const accessToken = params.credential.accessToken;

  const accountId = chatgptAccountId(accessToken);
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    'user-agent': 'marudesk-usage/1.0',
  };
  if (accountId) headers['chatgpt-account-id'] = accountId;

  const base = params.baseUrl?.replace(/\/+$/, '') ?? codexUsageBase();
  const url = `${base}/wham/usage`;
  let payload: unknown;
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: params.signal });
    if (!res.ok) return null;
    payload = await res.json();
  } catch {
    return null;
  }

  if (!isRecord(payload)) return null;
  const data = payload as CodexUsagePayload;
  const planType = typeof data.plan_type === 'string' ? data.plan_type : undefined;
  const rateLimit = isRecord(data.rate_limit) ? (data.rate_limit as CodexRateLimit) : undefined;
  const nowMs = Date.now();

  const limits: UsageLimit[] = [];
  if (rateLimit?.primary_window) {
    limits.push(buildLimit('primary', rateLimit.primary_window, accountId, planType, rateLimit.limit_reached, nowMs));
  }
  if (rateLimit?.secondary_window) {
    limits.push(buildLimit('secondary', rateLimit.secondary_window, accountId, planType, rateLimit.limit_reached, nowMs));
  }

  return {
    provider: 'openai-codex',
    fetchedAt: nowMs,
    limits,
    identity: accountId ? { accountId } : undefined,
    metadata: { planType, limitReached: rateLimit?.limit_reached },
    raw: payload,
  };
}

export const openaiCodexUsageProvider: UsageProvider = {
  id: 'openai-codex',
  fetchUsage: fetchCodexUsage,
  supports(params: UsageFetchParams): boolean {
    return (
      params.provider === 'openai-codex' &&
      params.credential.type === 'oauth' &&
      !!params.credential.accessToken
    );
  },
};
