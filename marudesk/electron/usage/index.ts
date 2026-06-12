import type {
  UsageProvider,
  UsageReport,
  UsageCredential,
  CredentialRankingStrategy,
} from './types';
import { claudeUsageProvider, claudeRankingStrategy } from './claude';
import { defineHandler } from '../ipc/define-handler';
import { getProviderOAuth, getProviderApiKey } from '../secrets';
import { isProviderId, type ProviderId } from '../../shared/providers';

/* ── Provider registry ─────────────────────────────────────────────────── */

const USAGE_PROVIDERS: UsageProvider[] = [claudeUsageProvider];

const RANKING_STRATEGIES: Partial<Record<string, CredentialRankingStrategy>> = {
  anthropic: claudeRankingStrategy,
};

/* ── Helpers ────────────────────────────────────────────────────────────── */

async function buildCredential(
  provider: ProviderId,
): Promise<UsageCredential | null> {
  const oauth = await getProviderOAuth(provider);
  if (oauth) {
    return {
      type: 'oauth',
      accessToken: oauth.accessToken,
      expiresAt: oauth.expiresAt,
    };
  }
  const apiKey = await getProviderApiKey(provider);
  if (apiKey) {
    return { type: 'api_key', apiKey };
  }
  return null;
}

/* ── Public API ─────────────────────────────────────────────────────────── */

export async function fetchUsageForProvider(
  provider: ProviderId,
): Promise<UsageReport | null> {
  const credential = await buildCredential(provider);
  if (!credential) return null;

  const usageProvider = USAGE_PROVIDERS.find((p) => p.id === provider);
  if (!usageProvider) return null;

  return usageProvider.fetchUsage({ provider, credential });
}

export async function fetchAllUsage(): Promise<UsageReport[]> {
  const results = await Promise.allSettled(
    USAGE_PROVIDERS.map((p) => fetchUsageForProvider(p.id as ProviderId)),
  );

  const reports: UsageReport[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      reports.push(result.value);
    }
  }
  return reports;
}

export function getRankingStrategy(
  provider: string,
): CredentialRankingStrategy | undefined {
  return RANKING_STRATEGIES[provider];
}

/* ── IPC handler registration ──────────────────────────────────────────── */

export function registerUsageHandlers(): void {
  defineHandler('usage:fetch', async ([provider]) => {
    if (!isProviderId(provider)) throw new Error('invalid provider');
    return fetchUsageForProvider(provider);
  });

  defineHandler('usage:fetch-all', () => fetchAllUsage());
}
