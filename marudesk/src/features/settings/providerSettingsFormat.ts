import { getProvider, type BuiltinProviderId } from '../../../shared/providers';

export function providerFriendlyName(providerId: BuiltinProviderId): string {
  switch (providerId) {
    case 'anthropic':
      return 'Claude';
    case 'xai':
      return 'Grok';
    case 'openai-codex':
      return 'ChatGPT';
    case 'google-caa':
      return 'Google';
    default:
      return getProvider(providerId).label;
  }
}
