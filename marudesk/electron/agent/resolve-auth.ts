import {
  getProvider,
  isBuiltinProviderId,
  type ProviderId,
} from '../../shared/providers';
import { getCustomProvider } from '../custom-providers';
import { getValidAccessToken } from '../oauth/flow';
import { supportsOAuth } from '../oauth/config';
import { getProviderApiKey } from '../secrets';
import type { ModelAuth } from './model';
import { toMessage } from '../../shared/to-message';

export type ResolvedProviderAuth =
  | { ok: true; auth: ModelAuth; baseUrl?: string }
  | { ok: false; reason: string };

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
