export type ProviderId = 'anthropic' | 'openai' | 'google';
export type AuthMode = 'apiKey' | 'oauth';

export type ModelDef = {
  id: string;
  label: string;
};

export type ProviderDef = {
  id: ProviderId;
  label: string;
  authModes: AuthMode[];
  defaultAuthMode: AuthMode;
  oauthStatus?: 'not-implemented';
  models: ModelDef[];
  defaultModelId: string;
  apiKeyPlaceholder: string;
  apiKeyHint: string;
};

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    authModes: ['apiKey'],
    defaultAuthMode: 'apiKey',
    models: [
      { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
      { id: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ],
    defaultModelId: 'claude-sonnet-4-5',
    apiKeyPlaceholder: 'sk-ant-...',
    apiKeyHint: 'console.anthropic.com → API Keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    authModes: ['apiKey', 'oauth'],
    defaultAuthMode: 'apiKey',
    oauthStatus: 'not-implemented',
    models: [
      { id: 'gpt-5', label: 'GPT-5' },
      { id: 'gpt-5-mini', label: 'GPT-5 mini' },
      { id: 'gpt-4.1', label: 'GPT-4.1' },
      { id: 'o4-mini', label: 'o4-mini' },
    ],
    defaultModelId: 'gpt-5',
    apiKeyPlaceholder: 'sk-...',
    apiKeyHint: 'platform.openai.com → API keys',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    authModes: ['apiKey', 'oauth'],
    defaultAuthMode: 'apiKey',
    oauthStatus: 'not-implemented',
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ],
    defaultModelId: 'gemini-2.5-pro',
    apiKeyPlaceholder: 'AIza...',
    apiKeyHint: 'aistudio.google.com → Get API key',
  },
];

export function getProvider(id: ProviderId): ProviderDef {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown provider: ${id}`);
  return p;
}

export function isProviderId(value: unknown): value is ProviderId {
  return (
    typeof value === 'string' &&
    PROVIDERS.some((p) => p.id === (value as ProviderId))
  );
}

export type ProviderStatus = {
  id: ProviderId;
  hasKey: boolean;
};
