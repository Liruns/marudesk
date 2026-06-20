import {
  buildUsageAmount,
  type UsageAmount,
  type UsageLimit,
  type UsageProvider,
  type UsageReport,
  type UsageWindow,
  type UsageFetchParams,
} from './types';

/**
 * GitHub Copilot usage provider (SECOND-PASS item 4; ref gajae
 * `usage/github-copilot.ts`). marudesk's agent path authenticates Copilot with
 * the device-flow OAuth token directly (model.ts `github-copilot` case), so the
 * quota endpoint is a clean fit: the same Bearer token reads
 * `api.github.com/copilot_internal/user`, which reports the monthly premium /
 * chat / completion quotas. Without it the gauge is blank and
 * {@link checkProviderQuota} returns ok unconditionally.
 */

const GITHUB_API_BASE = 'https://api.github.com';

interface CopilotQuotaDetail {
  entitlement?: number;
  remaining?: number;
  percent_remaining?: number;
  unlimited?: boolean;
  overage_count?: number;
}

interface CopilotUsageResponse {
  copilot_plan?: string;
  quota_reset_date?: string;
  quota_snapshots?: {
    chat?: CopilotQuotaDetail;
    completions?: CopilotQuotaDetail;
    premium_interactions?: CopilotQuotaDetail;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseQuotaDetail(value: unknown): CopilotQuotaDetail | null {
  if (!isRecord(value)) return null;
  const entitlement = toNumber(value.entitlement);
  const remaining = toNumber(value.remaining);
  const percentRemaining = toNumber(value.percent_remaining);
  const unlimited = typeof value.unlimited === 'boolean' ? value.unlimited : undefined;
  if (entitlement === undefined && remaining === undefined && percentRemaining === undefined && unlimited === undefined) {
    return null;
  }
  return {
    entitlement,
    remaining,
    percent_remaining: percentRemaining,
    unlimited,
    overage_count: toNumber(value.overage_count) ?? 0,
  };
}

function buildWindow(resetDate: string | undefined): UsageWindow | undefined {
  if (!resetDate) return undefined;
  const resetsAt = Date.parse(resetDate);
  if (!Number.isFinite(resetsAt)) return undefined;
  return { id: 'monthly', label: 'Monthly', resetsAt };
}

function quotaAmount(quota: CopilotQuotaDetail): UsageAmount {
  if (quota.unlimited) {
    return buildUsageAmount({ percentage: 0, unit: 'requests' });
  }
  if (quota.entitlement !== undefined && quota.remaining !== undefined) {
    const used = Math.max(0, quota.entitlement - quota.remaining);
    return buildUsageAmount({ used, limit: quota.entitlement, unit: 'requests' });
  }
  if (quota.percent_remaining !== undefined) {
    return buildUsageAmount({ percentage: 100 - quota.percent_remaining, unit: 'percent' });
  }
  return buildUsageAmount({ unit: 'requests' });
}

function quotaStatus(amount: UsageAmount, unlimited: boolean | undefined): UsageLimit['status'] {
  if (unlimited) return 'ok';
  const remainingFraction = amount.remainingFraction;
  if (remainingFraction === undefined) return 'unknown';
  if (remainingFraction <= 0) return 'exhausted';
  if (remainingFraction <= 0.1) return 'warning';
  return 'ok';
}

function buildLimit(
  key: string,
  label: string,
  quota: CopilotQuotaDetail,
  plan: string | undefined,
  window: UsageWindow | undefined,
): UsageLimit {
  const amount = quotaAmount(quota);
  const notes: string[] = [];
  if (quota.unlimited) notes.push('Unlimited');
  if ((quota.overage_count ?? 0) > 0) notes.push(`Overage requests: ${quota.overage_count}`);
  return {
    id: `github-copilot:${key}`,
    label,
    scope: { provider: 'github-copilot', tier: plan, windowId: window?.id },
    window,
    amount,
    status: quotaStatus(amount, quota.unlimited),
    notes: notes.length > 0 ? notes : undefined,
  };
}

async function fetchCopilotUsage(params: UsageFetchParams): Promise<UsageReport | null> {
  if (params.provider !== 'github-copilot') return null;
  const token = params.credential.type === 'oauth' ? params.credential.accessToken : params.credential.apiKey;
  if (!token) return null;

  const base = params.baseUrl?.replace(/\/+$/, '') ?? GITHUB_API_BASE;
  let payload: unknown;
  try {
    const res = await fetch(`${base}/copilot_internal/user`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'user-agent': 'marudesk-usage/1.0',
        'editor-version': 'marudesk/1.0',
      },
      signal: params.signal,
    });
    if (!res.ok) return null;
    payload = await res.json();
  } catch {
    return null;
  }

  if (!isRecord(payload)) return null;
  const data = payload as CopilotUsageResponse;
  const plan = typeof data.copilot_plan === 'string' ? data.copilot_plan : undefined;
  const window = buildWindow(data.quota_reset_date);
  const snapshots = data.quota_snapshots ?? {};

  const limits: UsageLimit[] = [];
  const premium = parseQuotaDetail(snapshots.premium_interactions);
  if (premium) limits.push(buildLimit('premium', 'Premium Requests', premium, plan, window));
  const chat = parseQuotaDetail(snapshots.chat);
  if (chat && !chat.unlimited) limits.push(buildLimit('chat', 'Chat Requests', chat, plan, window));
  const completions = parseQuotaDetail(snapshots.completions);
  if (completions && !completions.unlimited) limits.push(buildLimit('completions', 'Completions', completions, plan, window));

  return {
    provider: 'github-copilot',
    fetchedAt: Date.now(),
    limits,
    metadata: { plan, quotaResetDate: data.quota_reset_date },
    raw: payload,
  };
}

export const githubCopilotUsageProvider: UsageProvider = {
  id: 'github-copilot',
  fetchUsage: fetchCopilotUsage,
  supports(params: UsageFetchParams): boolean {
    if (params.provider !== 'github-copilot') return false;
    if (params.credential.type === 'oauth') return !!params.credential.accessToken;
    return !!params.credential.apiKey;
  },
};
