import {
  ANTHROPIC_OAUTH_BETA,
  ANTHROPIC_OAUTH_HEADERS,
} from '../oauth/config';
import {
  buildUsageAmount,
  getUsageStatus,
  type CredentialRankingStrategy,
  type UsageFetchParams,
  type UsageLimit,
  type UsageProvider,
  type UsageReport,
} from './types';

export const CLAUDE_DEFAULT_BASE = 'https://api.anthropic.com';

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface ClaudeUsageBucket {
  bucket_name: string;
  utilization: number;
  reset_at: string;
  bucket_type: string;
  [key: string]: unknown;
}

interface ClaudeUsageResponse {
  rate_limits: ClaudeUsageBucket[];
}

async function fetchUsagePayload(
  baseUrl: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<ClaudeUsageResponse | null> {
  try {
    const res = await fetch(`${baseUrl}/v1/rate_limits`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': ANTHROPIC_OAUTH_BETA,
        'user-agent': 'marudesk-usage/1.0',
        'x-app': ANTHROPIC_OAUTH_HEADERS['x-app'],
      },
      signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as ClaudeUsageResponse;
  } catch {
    return null;
  }
}

function parseBucket(bucket: ClaudeUsageBucket): {
  utilization: number;
  resetAt: number;
  windowMs: number;
} {
  const utilization = Math.max(0, Math.min(1, bucket.utilization));
  const resetAt = new Date(bucket.reset_at).getTime();
  const windowMs = bucket.bucket_type === 'weekly' ? SEVEN_DAYS_MS : FIVE_HOURS_MS;
  return { utilization, resetAt, windowMs };
}

async function fetchClaudeUsage(
  params: UsageFetchParams,
): Promise<UsageReport | null> {
  if (params.provider !== 'anthropic') return null;
  if (params.credential.type !== 'oauth' || !params.credential.accessToken) {
    return null;
  }

  const baseUrl = params.baseUrl ?? CLAUDE_DEFAULT_BASE;
  const payload = await fetchUsagePayload(
    baseUrl,
    params.credential.accessToken,
    params.signal,
  );
  if (!payload?.rate_limits) return null;

  const limits: UsageLimit[] = payload.rate_limits.map((bucket) => {
    const { utilization, resetAt, windowMs } = parseBucket(bucket);
    const status = getUsageStatus(utilization);

    return {
      id: `anthropic:${bucket.bucket_name}`,
      label: bucket.bucket_name,
      scope: {
        provider: 'anthropic',
        windowId: bucket.bucket_type,
      },
      window: {
        id: bucket.bucket_type,
        label: bucket.bucket_type,
        durationMs: windowMs,
        resetsAt: resetAt,
      },
      amount: buildUsageAmount({
        percentage: utilization * 100,
        unit: 'percent',
      }),
      status,
    };
  });

  return {
    provider: 'anthropic',
    fetchedAt: Date.now(),
    limits,
    raw: payload,
  };
}

export const claudeUsageProvider: UsageProvider = {
  id: 'anthropic',
  fetchUsage: fetchClaudeUsage,
  supports(params: UsageFetchParams): boolean {
    return (
      params.provider === 'anthropic' &&
      params.credential.type === 'oauth' &&
      !!params.credential.accessToken
    );
  },
};

export const claudeRankingStrategy: CredentialRankingStrategy = {
  findWindowLimits(report: UsageReport) {
    let primary: UsageLimit | undefined;
    let secondary: UsageLimit | undefined;

    for (const limit of report.limits) {
      const dur = limit.window?.durationMs;
      if (dur === undefined) continue;
      if (Math.abs(dur - FIVE_HOURS_MS) < 1000) {
        if (!primary || (limit.amount.usedFraction ?? 0) > (primary.amount.usedFraction ?? 0)) {
          primary = limit;
        }
      } else if (Math.abs(dur - SEVEN_DAYS_MS) < 1000) {
        if (!secondary || (limit.amount.usedFraction ?? 0) > (secondary.amount.usedFraction ?? 0)) {
          secondary = limit;
        }
      }
    }

    return { primary, secondary };
  },
  windowDefaults: { primaryMs: FIVE_HOURS_MS, secondaryMs: SEVEN_DAYS_MS },
};
