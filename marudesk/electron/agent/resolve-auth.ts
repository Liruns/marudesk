import {
  getProvider,
  isBuiltinProviderId,
  type ProviderId,
} from '../../shared/providers';
import { getCustomProvider } from '../custom-providers';
import { getValidAccessToken } from '../oauth/flow';
import { supportsOAuth } from '../oauth/config';
import { getProviderApiKey } from '../secrets';
import { fetchUsageForProvider } from '../usage';
import type { ModelAuth } from './model';
import { toMessage } from '../../shared/to-message';

export type ResolvedProviderAuth =
  | { ok: true; auth: ModelAuth; baseUrl?: string }
  | { ok: false; reason: string };

const ADC_PROVIDERS = new Set(['google-vertex', 'amazon-bedrock']);

async function resolveAdcAuth(provider: ProviderId): Promise<ModelAuth | null> {
  if (provider === 'google-vertex') {
    try {
      const { getVertexAccessToken } = await import('../auth/vertex-adc');
      const token = await getVertexAccessToken();
      if (token) return { mode: 'oauth', accessToken: token };
    } catch { /* ADC not configured */ }
  }
  if (provider === 'amazon-bedrock') {
    try {
      const { resolveAwsCredentials } = await import('../auth/aws-sigv4');
      const creds = await resolveAwsCredentials();
      if (creds) return { mode: 'api-key', apiKey: `${creds.accessKeyId}:${creds.secretAccessKey}${creds.sessionToken ? ':' + creds.sessionToken : ''}` };
    } catch { /* AWS creds not configured */ }
  }
  return null;
}

export async function resolveProviderAuth(
  provider: ProviderId,
): Promise<ResolvedProviderAuth> {
  let apiKey: string | null;
  try {
    apiKey = await getProviderApiKey(provider);
  } catch (err) {
    return { ok: false, reason: toMessage(err) };
  }
  if (isBuiltinProviderId(provider)) {
    let auth: ModelAuth | null = null;

    // ADC-based providers (Vertex, Bedrock) resolve credentials from the
    // environment rather than stored secrets.
    if (ADC_PROVIDERS.has(provider)) {
      auth = await resolveAdcAuth(provider);
      if (!auth && apiKey) auth = { mode: 'api-key', apiKey };
      if (!auth) {
        return {
          ok: false,
          reason: provider === 'google-vertex'
            ? 'no Google Cloud credentials found — run gcloud auth application-default login or set GOOGLE_APPLICATION_CREDENTIALS'
            : 'no AWS credentials found — set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY or configure ~/.aws/credentials',
        };
      }
      return { ok: true, auth };
    }

    if (supportsOAuth(provider)) {
      let accessToken: string | null = null;
      try {
        accessToken = await getValidAccessToken(provider);
      } catch (err) {
        if (!apiKey) return { ok: false, reason: toMessage(err) };
      }
      if (accessToken) auth = { mode: 'oauth', accessToken };
    }
    if (!auth) {
      if (!apiKey && !getProvider(provider).keyless) {
        return {
          ok: false,
          reason: supportsOAuth(provider)
            ? `no API key or OAuth connection for ${provider}`
            : `no API key configured for ${provider}`,
        };
      }
      auth = { mode: 'api-key', apiKey: apiKey ?? '' };
    }
    return { ok: true, auth };
  }
  const custom = await getCustomProvider(provider);
  if (!custom) return { ok: false, reason: `unknown custom provider ${provider}` };
  return { ok: true, auth: { mode: 'api-key', apiKey: apiKey ?? '' }, baseUrl: custom.baseUrl };
}

export async function checkProviderQuota(provider: ProviderId): Promise<{
  ok: boolean;
  usedFraction?: number;
  resetsAt?: number;
  status?: string;
}> {
  try {
    const report = await fetchUsageForProvider(provider);
    if (!report || report.limits.length === 0) return { ok: true };
    const worst = report.limits.reduce((a, b) =>
      (a.amount.usedFraction ?? 0) > (b.amount.usedFraction ?? 0) ? a : b,
    );
    return {
      ok: worst.status !== 'exhausted',
      usedFraction: worst.amount.usedFraction,
      resetsAt: worst.window?.resetsAt,
      status: worst.status,
    };
  } catch {
    return { ok: true };
  }
}
