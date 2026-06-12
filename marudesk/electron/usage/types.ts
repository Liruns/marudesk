/** Usage monitoring type system for AI provider rate/quota tracking. */

export type UsageUnit =
  | 'percent'
  | 'tokens'
  | 'requests'
  | 'usd'
  | 'minutes'
  | 'bytes'
  | 'unknown';

export type UsageStatus = 'ok' | 'warning' | 'exhausted' | 'unknown';

export interface UsageWindow {
  id: string;
  label: string;
  durationMs?: number;
  resetsAt?: number;
}

export interface UsageAmount {
  used?: number;
  limit?: number;
  remaining?: number;
  usedFraction?: number;
  remainingFraction?: number;
  unit: UsageUnit;
}

export interface UsageScope {
  provider: string;
  accountId?: string;
  modelId?: string;
  tier?: string;
  windowId?: string;
  shared?: boolean;
}

export interface UsageLimit {
  id: string;
  label: string;
  scope: UsageScope;
  window?: UsageWindow;
  amount: UsageAmount;
  status?: UsageStatus;
  notes?: string[];
}

export interface UsageReport {
  provider: string;
  fetchedAt: number;
  limits: UsageLimit[];
  identity?: { accountId?: string; email?: string };
  metadata?: Record<string, unknown>;
  raw?: unknown;
}

export interface UsageCredential {
  type: 'api_key' | 'oauth';
  apiKey?: string;
  accessToken?: string;
  expiresAt?: number;
}

export interface UsageFetchParams {
  provider: string;
  credential: UsageCredential;
  baseUrl?: string;
  signal?: AbortSignal;
}

export interface UsageProvider {
  id: string;
  fetchUsage(params: UsageFetchParams): Promise<UsageReport | null>;
  supports?(params: UsageFetchParams): boolean;
}

export interface CredentialRankingStrategy {
  findWindowLimits(report: UsageReport): {
    primary?: UsageLimit;
    secondary?: UsageLimit;
  };
  windowDefaults: { primaryMs: number; secondaryMs: number };
  hasPriorityBoost?(primary: UsageLimit | undefined): boolean;
}

export function getUsageStatus(
  usedFraction: number | undefined,
): UsageStatus | undefined {
  if (usedFraction === undefined) return undefined;
  if (usedFraction >= 1) return 'exhausted';
  if (usedFraction >= 0.9) return 'warning';
  return 'ok';
}

export function buildUsageAmount(args: {
  used?: number;
  limit?: number;
  remaining?: number;
  percentage?: number;
  unit: UsageUnit;
}): UsageAmount {
  const { unit } = args;
  let { used, limit, remaining } = args;
  const { percentage } = args;

  if (used !== undefined && limit !== undefined && remaining === undefined) {
    remaining = limit - used;
  } else if (
    remaining !== undefined &&
    limit !== undefined &&
    used === undefined
  ) {
    used = limit - remaining;
  } else if (
    used !== undefined &&
    remaining !== undefined &&
    limit === undefined
  ) {
    limit = used + remaining;
  }

  let usedFraction: number | undefined;
  let remainingFraction: number | undefined;

  if (percentage !== undefined) {
    usedFraction = percentage / 100;
    remainingFraction = 1 - usedFraction;
  } else if (used !== undefined && limit !== undefined && limit > 0) {
    usedFraction = used / limit;
    remainingFraction = 1 - usedFraction;
  }

  return { used, limit, remaining, usedFraction, remainingFraction, unit };
}
