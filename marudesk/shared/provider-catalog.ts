import type { ModelEntry, ProviderDef } from './providers.ts';

/**
 * Static provider + model catalog data, split out of providers.ts so the
 * module keeps types + logic and this holds the (large) literal tables. Live
 * `/models` lists and custom endpoints are merged over these at runtime.
 */

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    oauth: true,
    models: [
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    ],
    defaultModelId: 'claude-sonnet-4-6',
    apiKeyPlaceholder: 'sk-ant-...',
    apiKeyHint: 'console.anthropic.com → API Keys',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    models: [
      { id: 'gpt-5', label: 'GPT-5' },
      { id: 'gpt-5-mini', label: 'GPT-5 mini' },
      { id: 'gpt-4.1', label: 'GPT-4.1' },
      { id: 'o4-mini', label: 'o4-mini' },
      { id: 'gpt-image-2', label: 'GPT Image 2' },
      { id: 'sora-2', label: 'Sora 2' },
      { id: 'sora-2-pro', label: 'Sora 2 Pro' },
    ],
    defaultModelId: 'gpt-5',
    apiKeyPlaceholder: 'sk-...',
    apiKeyHint: 'platform.openai.com → API keys',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite' },
    ],
    defaultModelId: 'gemini-2.5-pro',
    apiKeyPlaceholder: 'AIza...',
    apiKeyHint: 'aistudio.google.com → Get API key',
    apiKeyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    oauth: true,
    // NB: grok-2/grok-3/grok-4* and grok-code-fast-1 were RETIRED 2026-05-15
    // (requests now redirect to grok-4.3 and bill at its rate) — do not list
    // them. Current chat models per docs.x.ai / models.dev: grok-4.3 (default
    // workhorse) and grok-build-0.1 (coding-specialized). The live /models fetch
    // (electron/models.ts) refreshes this list once an API key is set.
    models: [
      { id: 'grok-4.3', label: 'Grok 4.3' },
      { id: 'grok-build-0.1', label: 'Grok Build (coding)' },
      { id: 'grok-imagine-image-quality', label: 'Grok Imagine Image Quality' },
      { id: 'grok-imagine-video', label: 'Grok Imagine Video' },
    ],
    defaultModelId: 'grok-4.3',
    apiKeyPlaceholder: 'xai-...',
    apiKeyHint: 'console.x.ai → API Keys, or "Connect with Grok" to use your account',
    apiKeyUrl: 'https://console.x.ai',
  },
  {
    id: 'openai-codex',
    label: 'OpenAI (ChatGPT)',
    oauth: true,
    oauthOnly: true,
    experimental: true,
    // Codex backend models (Responses dialect) — chatgpt.com/backend-api/codex.
    // The bare `gpt-5` slug is rejected on a ChatGPT account ("not supported when
    // using Codex with a ChatGPT account") — use a `-codex`/versioned slug. The
    // accepted set tracks the Codex CLI and is NOT the API-key set; as of
    // 2026-06 it includes gpt-5-codex, gpt-5.3-codex, and gpt-5.5 (default for
    // ChatGPT-auth sessions). ⚠ Unverified against a live account — confirm by
    // dogfood; see docs/agentic-chat-v4-design.md §A3.
    models: [
      { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
      { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
      { id: 'gpt-5.5', label: 'GPT-5.5' },
    ],
    defaultModelId: 'gpt-5-codex',
    apiKeyPlaceholder: '(OAuth only)',
    apiKeyHint: 'Sign in with your ChatGPT (Plus/Pro) account — no API key.',
  },
  {
    id: 'google-caa',
    label: 'Google (Gemini account)',
    oauth: true,
    oauthOnly: true,
    experimental: true,
    // Served via the Code-Assist backend (cloudcode-pa) on a personal Google
    // account. Accepts the GA Code Assist models gemini-2.5-pro / -flash.
    // ⚠ Gemini Code Assist for individual/consumer accounts is scheduled to stop
    // serving on 2026-06-18 (migration to Antigravity CLI) — this provider may
    // stop working after that date. Unverified against a live account; dogfood.
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (account)' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (account)' },
    ],
    defaultModelId: 'gemini-2.5-pro',
    apiKeyPlaceholder: '(OAuth only)',
    apiKeyHint: 'Sign in with your Google account — no API key.',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    keyless: true,
    // Common local coding models; the live list is fetched from /api/tags.
    models: [
      { id: 'qwen2.5-coder', label: 'Qwen2.5 Coder' },
      { id: 'llama3.1', label: 'Llama 3.1' },
    ],
    defaultModelId: 'qwen2.5-coder',
    apiKeyPlaceholder: '(local — no key)',
    apiKeyHint: 'Runs locally at localhost:11434 (no key). Use a tool-capable model.',
  },
  {
    id: 'zai',
    label: 'Z.ai (GLM)',
    // Zhipu's GLM family via the OpenAI-compatible API at api.z.ai/api/paas/v4
    // (Bearer auth). The live list is fetched once a key is set; these seed it.
    // A GLM Coding Plan key instead targets api.z.ai/api/coding/paas/v4 — add it
    // as a custom endpoint if you have a Coding-Plan-scoped key.
    models: [
      { id: 'glm-4.6', label: 'GLM-4.6' },
      { id: 'glm-4.5', label: 'GLM-4.5' },
      { id: 'glm-4.5-air', label: 'GLM-4.5 Air' },
    ],
    defaultModelId: 'glm-4.6',
    apiKeyPlaceholder: '••••••••',
    apiKeyHint: 'z.ai → API keys (ZHIPU_API_KEY)',
    apiKeyUrl: 'https://z.ai/manage-apikey/apikey-list',
  },
  {
    id: 'opencode',
    label: 'OpenCode Zen',
    // OpenCode's curated gateway (opencode.ai/zen/v1) re-exposes GPT/Claude/Gemini/
    // Grok/Qwen/GLM/Kimi behind one OpenAI-compatible endpoint (Bearer auth). Model
    // ids are passed bare; the live /models fetch refreshes this seed once a key is set.
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'grok-code', label: 'Grok Code Fast 1' },
    ],
    defaultModelId: 'gpt-5.5',
    apiKeyPlaceholder: '••••••••',
    apiKeyHint: 'opencode.ai/zen → API keys (OPENCODE_API_KEY)',
    apiKeyUrl: 'https://opencode.ai/zen',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    // The 300+ model gateway (openrouter.ai/api/v1), OpenAI-compatible Bearer
    // auth. Model ids are `vendor/model`; the live /models fetch (no key needed
    // to list) refreshes this seed once a key is set.
    models: [
      { id: 'openai/gpt-5.5', label: 'GPT-5.5 (OpenAI)' },
      { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6 (Anthropic)' },
      { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro (Google)' },
      { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' },
    ],
    defaultModelId: 'anthropic/claude-sonnet-4.6',
    apiKeyPlaceholder: 'sk-or-...',
    apiKeyHint: 'openrouter.ai → Keys (OPENROUTER_API_KEY)',
    apiKeyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'groq',
    label: 'Groq',
    // Groq's fast LPU inference, OpenAI-compatible at api.groq.com/openai/v1.
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile' },
      { id: 'moonshotai/kimi-k2-instruct', label: 'Kimi K2 Instruct' },
      { id: 'qwen/qwen3-32b', label: 'Qwen3 32B' },
    ],
    defaultModelId: 'llama-3.3-70b-versatile',
    apiKeyPlaceholder: 'gsk_...',
    apiKeyHint: 'console.groq.com → API Keys (GROQ_API_KEY)',
    apiKeyUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    // Cerebras wafer-scale inference, OpenAI-compatible at api.cerebras.ai/v1.
    models: [
      { id: 'llama-3.3-70b', label: 'Llama 3.3 70B' },
      { id: 'qwen-3-235b-a22b-instruct', label: 'Qwen3 235B A22B Instruct' },
    ],
    defaultModelId: 'llama-3.3-70b',
    apiKeyPlaceholder: 'csk-...',
    apiKeyHint: 'cloud.cerebras.ai → API Keys (CEREBRAS_API_KEY)',
    apiKeyUrl: 'https://cloud.cerebras.ai',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    // Mistral La Plateforme, OpenAI-compatible at api.mistral.ai/v1.
    models: [
      { id: 'mistral-large-latest', label: 'Mistral Large' },
      { id: 'mistral-small-latest', label: 'Mistral Small' },
      { id: 'codestral-latest', label: 'Codestral' },
    ],
    defaultModelId: 'mistral-large-latest',
    apiKeyPlaceholder: '••••••••',
    apiKeyHint: 'console.mistral.ai → API Keys (MISTRAL_API_KEY)',
    apiKeyUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    // DeepSeek platform, OpenAI-compatible at api.deepseek.com.
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
    ],
    defaultModelId: 'deepseek-chat',
    apiKeyPlaceholder: 'sk-...',
    apiKeyHint: 'platform.deepseek.com → API keys (DEEPSEEK_API_KEY)',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'together',
    label: 'Together AI',
    // Together's OpenAI-compatible API at api.together.xyz/v1 (Bearer key). A
    // large catalog of open models; the live /models fetch refreshes this seed
    // once a key is set. Default to a stable tool-capable workhorse.
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B Turbo' },
      { id: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek V3' },
      { id: 'Qwen/Qwen2.5-Coder-32B-Instruct', label: 'Qwen2.5 Coder 32B' },
      { id: 'moonshotai/Kimi-K2-Instruct', label: 'Kimi K2 Instruct' },
    ],
    defaultModelId: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    apiKeyPlaceholder: '••••••••',
    apiKeyHint: 'api.together.ai → API Keys (TOGETHER_API_KEY)',
    apiKeyUrl: 'https://api.together.ai/settings/api-keys',
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    // Fireworks' OpenAI-compatible API at api.fireworks.ai/inference/v1 (Bearer
    // key). Model ids are `accounts/fireworks/models/<name>`; the live /models
    // fetch refreshes this seed once a key is set.
    models: [
      { id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', label: 'Llama 3.3 70B' },
      { id: 'accounts/fireworks/models/deepseek-v3', label: 'DeepSeek V3' },
      { id: 'accounts/fireworks/models/qwen2p5-coder-32b-instruct', label: 'Qwen2.5 Coder 32B' },
      { id: 'accounts/fireworks/models/kimi-k2-instruct', label: 'Kimi K2 Instruct' },
    ],
    defaultModelId: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    apiKeyPlaceholder: 'fw_...',
    apiKeyHint: 'fireworks.ai → API Keys (FIREWORKS_API_KEY)',
    apiKeyUrl: 'https://fireworks.ai/account/api-keys',
  },
  {
    id: 'github-copilot',
    label: 'GitHub Copilot',
    oauth: true,
    oauthOnly: true,
    models: [
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'gpt-5', label: 'GPT-5' },
      { id: 'gpt-5-mini', label: 'GPT-5 mini' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'o4-mini', label: 'o4-mini' },
    ],
    defaultModelId: 'claude-sonnet-4-6',
    apiKeyPlaceholder: '(OAuth only)',
    apiKeyHint: 'Sign in with your GitHub account — uses your Copilot subscription.',
  },
  {
    id: 'google-vertex',
    label: 'Google Vertex AI',
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { id: 'claude-sonnet-4-6@anthropic', label: 'Claude Sonnet 4.6 (Anthropic)' },
    ],
    defaultModelId: 'gemini-2.5-pro',
    apiKeyPlaceholder: '(ADC — no key)',
    apiKeyHint: 'Uses Application Default Credentials (gcloud auth). Set GOOGLE_APPLICATION_CREDENTIALS or run gcloud auth application-default login.',
  },
  {
    id: 'amazon-bedrock',
    label: 'Amazon Bedrock',
    models: [
      { id: 'anthropic.claude-sonnet-4-6-v1:0', label: 'Claude Sonnet 4.6' },
      { id: 'anthropic.claude-haiku-4-5-v1:0', label: 'Claude Haiku 4.5' },
      { id: 'amazon.nova-pro-v1:0', label: 'Amazon Nova Pro' },
    ],
    defaultModelId: 'anthropic.claude-sonnet-4-6-v1:0',
    apiKeyPlaceholder: '(AWS credentials)',
    apiKeyHint: 'Uses AWS credentials (env vars or ~/.aws/credentials). Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY.',
  },
  {
    id: 'gitlab-duo',
    label: 'GitLab Duo',
    models: [
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
      { id: 'gpt-5', label: 'GPT-5' },
      { id: 'gpt-5-mini', label: 'GPT-5 mini' },
    ],
    defaultModelId: 'claude-sonnet-4-6',
    apiKeyPlaceholder: 'glpat-...',
    apiKeyHint: 'GitLab personal access token with api scope. gitlab.com → Settings → Access Tokens.',
    apiKeyUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens',
  },
  {
    id: 'azure-openai',
    label: 'Azure OpenAI',
    models: [
      { id: 'gpt-5', label: 'GPT-5' },
      { id: 'gpt-5-mini', label: 'GPT-5 mini' },
      { id: 'gpt-4.1', label: 'GPT-4.1' },
    ],
    defaultModelId: 'gpt-5',
    apiKeyPlaceholder: '••••••••',
    apiKeyHint: 'Azure OpenAI API key. Set the endpoint via AZURE_OPENAI_ENDPOINT or custom base URL.',
  },
];

export const MODELS: ModelEntry[] = [
  // Anthropic (Claude 4.x — all tool-capable; vision + extended thinking).
  // Opus/Sonnet 4.6+ carry a 1M-token context; Haiku 4.5 is 200K.
  { key: 'anthropic:claude-opus-4-8', id: 'claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'anthropic', contextWindow: 1_000_000, tools: true, vision: true, reasoning: true },
  { key: 'anthropic:claude-sonnet-4-6', id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic', contextWindow: 1_000_000, tools: true, vision: true, reasoning: true },
  { key: 'anthropic:claude-haiku-4-5-20251001', id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'anthropic', contextWindow: 200_000, tools: true, vision: true, reasoning: true },
  // OpenAI (GPT-5 family = 400K context; gpt-4.1 the prior 1M-context gen).
  { key: 'openai:gpt-5', id: 'gpt-5', label: 'GPT-5', provider: 'openai', contextWindow: 400_000, tools: true, vision: true, reasoning: true },
  { key: 'openai:gpt-5-mini', id: 'gpt-5-mini', label: 'GPT-5 mini', provider: 'openai', contextWindow: 400_000, tools: true, vision: true, reasoning: true },
  { key: 'openai:gpt-4.1', id: 'gpt-4.1', label: 'GPT-4.1', provider: 'openai', contextWindow: 1_047_576, tools: true, vision: true },
  { key: 'openai:o4-mini', id: 'o4-mini', label: 'o4-mini', provider: 'openai', contextWindow: 200_000, tools: true, reasoning: true },
  { key: 'openai:gpt-image-2', id: 'gpt-image-2', label: 'GPT Image 2', provider: 'openai', tools: false, vision: true, imageGeneration: true, imageEdit: true, imageTransport: 'openai-images' },
  { key: 'openai:sora-2', id: 'sora-2', label: 'Sora 2', provider: 'openai', tools: false, vision: true, videoGeneration: true, videoEdit: true, videoTransport: 'openai-videos' },
  { key: 'openai:sora-2-pro', id: 'sora-2-pro', label: 'Sora 2 Pro', provider: 'openai', tools: false, vision: true, videoGeneration: true, videoEdit: true, videoTransport: 'openai-videos' },
  // Google Gemini (~1M context).
  { key: 'google:gemini-2.5-pro', id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'google', contextWindow: 1_048_576, tools: true, vision: true, reasoning: true },
  { key: 'google:gemini-2.5-flash', id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'google', contextWindow: 1_048_576, tools: true, vision: true, reasoning: true },
  { key: 'google:gemini-2.5-flash-lite', id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', provider: 'google', contextWindow: 1_048_576, tools: true, vision: true },
  // xAI Grok (OpenAI-compatible API at api.x.ai/v1; tool-capable). grok-2/3/4*
  // and grok-code-fast-1 were retired 2026-05-15 — current models only.
  { key: 'xai:grok-4.3', id: 'grok-4.3', label: 'Grok 4.3', provider: 'xai', contextWindow: 1_000_000, tools: true, vision: true, reasoning: true },
  { key: 'xai:grok-build-0.1', id: 'grok-build-0.1', label: 'Grok Build (coding)', provider: 'xai', contextWindow: 256_000, tools: true },
  { key: 'xai:grok-imagine-image-quality', id: 'grok-imagine-image-quality', label: 'Grok Imagine Image Quality', provider: 'xai', tools: false, vision: true, imageGeneration: true, imageEdit: true, imageTransport: 'openai-compatible-images' },
  { key: 'xai:grok-imagine-video', id: 'grok-imagine-video', label: 'Grok Imagine Video', provider: 'xai', tools: false, vision: true, videoGeneration: true, videoEdit: true, videoTransport: 'xai-videos' },
  // OpenAI ChatGPT (Codex backend, OAuth-only — Responses dialect). Experimental.
  // The bare `gpt-5` slug 400s ("not supported when using Codex with a ChatGPT
  // account"); use a codex/versioned slug. Accepted set tracks the Codex CLI (≠
  // the API-key set) and is unverified against a live account — confirm by dogfood.
  { key: 'openai-codex:gpt-5-codex', id: 'gpt-5-codex', label: 'GPT-5 Codex', provider: 'openai-codex', tools: true, reasoning: true },
  { key: 'openai-codex:gpt-5.3-codex', id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', provider: 'openai-codex', tools: true, reasoning: true },
  { key: 'openai-codex:gpt-5.5', id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai-codex', tools: true, reasoning: true },
  // Google Gemini via a personal account (Code-Assist backend, OAuth-only). Experimental.
  { key: 'google-caa:gemini-2.5-pro', id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (account)', provider: 'google-caa', contextWindow: 1_048_576, tools: true, vision: true, reasoning: true },
  { key: 'google-caa:gemini-2.5-flash', id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (account)', provider: 'google-caa', contextWindow: 1_048_576, tools: true, vision: true, reasoning: true },
  // Ollama (local; tool support varies — these two are tool-capable).
  { key: 'ollama:qwen2.5-coder', id: 'qwen2.5-coder', label: 'Qwen2.5 Coder', provider: 'ollama', tools: true },
  { key: 'ollama:llama3.1', id: 'llama3.1', label: 'Llama 3.1', provider: 'ollama', tools: true },
  // Z.ai GLM (OpenAI-compatible at api.z.ai/api/paas/v4; tool-capable + reasoning).
  { key: 'zai:glm-4.6', id: 'glm-4.6', label: 'GLM-4.6', provider: 'zai', contextWindow: 204_800, tools: true, reasoning: true },
  { key: 'zai:glm-4.5', id: 'glm-4.5', label: 'GLM-4.5', provider: 'zai', contextWindow: 131_072, tools: true, reasoning: true },
  { key: 'zai:glm-4.5-air', id: 'glm-4.5-air', label: 'GLM-4.5 Air', provider: 'zai', contextWindow: 131_072, tools: true, reasoning: true },
  // OpenCode Zen gateway (opencode.ai/zen/v1) — curated multi-vendor catalog.
  { key: 'opencode:gpt-5.5', id: 'gpt-5.5', label: 'GPT-5.5', provider: 'opencode', contextWindow: 400_000, tools: true, reasoning: true },
  { key: 'opencode:claude-sonnet-4-6', id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'opencode', contextWindow: 1_000_000, tools: true, vision: true, reasoning: true },
  { key: 'opencode:grok-code', id: 'grok-code', label: 'Grok Code Fast 1', provider: 'opencode', contextWindow: 256_000, tools: true },
  // OpenRouter gateway (openrouter.ai/api/v1) — `vendor/model` ids routed to the
  // underlying provider. The live /models fetch refreshes this seed once a key is set.
  { key: 'openrouter:openai/gpt-5.5', id: 'openai/gpt-5.5', label: 'GPT-5.5 (OpenAI)', provider: 'openrouter', contextWindow: 400_000, tools: true, reasoning: true },
  { key: 'openrouter:anthropic/claude-sonnet-4.6', id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6 (Anthropic)', provider: 'openrouter', contextWindow: 1_000_000, tools: true, vision: true, reasoning: true },
  { key: 'openrouter:google/gemini-2.5-pro', id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro (Google)', provider: 'openrouter', contextWindow: 1_048_576, tools: true, vision: true, reasoning: true },
  { key: 'openrouter:deepseek/deepseek-chat', id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat', provider: 'openrouter', contextWindow: 163_840, tools: true },
  // Groq (api.groq.com/openai/v1) — OpenAI-compatible, tool-capable open models.
  { key: 'groq:llama-3.3-70b-versatile', id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile', provider: 'groq', contextWindow: 131_072, tools: true },
  { key: 'groq:moonshotai/kimi-k2-instruct', id: 'moonshotai/kimi-k2-instruct', label: 'Kimi K2 Instruct', provider: 'groq', contextWindow: 131_072, tools: true },
  { key: 'groq:qwen/qwen3-32b', id: 'qwen/qwen3-32b', label: 'Qwen3 32B', provider: 'groq', contextWindow: 131_072, tools: true, reasoning: true },
  // Cerebras (api.cerebras.ai/v1) — OpenAI-compatible, very high throughput.
  { key: 'cerebras:llama-3.3-70b', id: 'llama-3.3-70b', label: 'Llama 3.3 70B', provider: 'cerebras', contextWindow: 131_072, tools: true },
  { key: 'cerebras:qwen-3-235b-a22b-instruct', id: 'qwen-3-235b-a22b-instruct', label: 'Qwen3 235B A22B Instruct', provider: 'cerebras', contextWindow: 131_072, tools: true, reasoning: true },
  // Mistral (api.mistral.ai/v1) — OpenAI-compatible.
  { key: 'mistral:mistral-large-latest', id: 'mistral-large-latest', label: 'Mistral Large', provider: 'mistral', contextWindow: 131_072, tools: true },
  { key: 'mistral:mistral-small-latest', id: 'mistral-small-latest', label: 'Mistral Small', provider: 'mistral', contextWindow: 131_072, tools: true },
  { key: 'mistral:codestral-latest', id: 'codestral-latest', label: 'Codestral', provider: 'mistral', contextWindow: 262_144, tools: true },
  // DeepSeek (api.deepseek.com) — OpenAI-compatible; -reasoner is the R1 line.
  { key: 'deepseek:deepseek-chat', id: 'deepseek-chat', label: 'DeepSeek Chat', provider: 'deepseek', contextWindow: 163_840, tools: true },
  { key: 'deepseek:deepseek-reasoner', id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', provider: 'deepseek', contextWindow: 163_840, tools: true, reasoning: true },
  // Together AI (api.together.xyz/v1) — OpenAI-compatible open-model gateway.
  { key: 'together:meta-llama/Llama-3.3-70B-Instruct-Turbo', id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B Turbo', provider: 'together', contextWindow: 131_072, tools: true },
  { key: 'together:deepseek-ai/DeepSeek-V3', id: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek V3', provider: 'together', contextWindow: 131_072, tools: true },
  { key: 'together:Qwen/Qwen2.5-Coder-32B-Instruct', id: 'Qwen/Qwen2.5-Coder-32B-Instruct', label: 'Qwen2.5 Coder 32B', provider: 'together', contextWindow: 32_768, tools: true },
  { key: 'together:moonshotai/Kimi-K2-Instruct', id: 'moonshotai/Kimi-K2-Instruct', label: 'Kimi K2 Instruct', provider: 'together', contextWindow: 131_072, tools: true },
  // Fireworks AI (api.fireworks.ai/inference/v1) — OpenAI-compatible; `accounts/…` ids.
  { key: 'fireworks:accounts/fireworks/models/llama-v3p3-70b-instruct', id: 'accounts/fireworks/models/llama-v3p3-70b-instruct', label: 'Llama 3.3 70B', provider: 'fireworks', contextWindow: 131_072, tools: true },
  { key: 'fireworks:accounts/fireworks/models/deepseek-v3', id: 'accounts/fireworks/models/deepseek-v3', label: 'DeepSeek V3', provider: 'fireworks', contextWindow: 131_072, tools: true },
  { key: 'fireworks:accounts/fireworks/models/qwen2p5-coder-32b-instruct', id: 'accounts/fireworks/models/qwen2p5-coder-32b-instruct', label: 'Qwen2.5 Coder 32B', provider: 'fireworks', contextWindow: 32_768, tools: true },
  { key: 'fireworks:accounts/fireworks/models/kimi-k2-instruct', id: 'accounts/fireworks/models/kimi-k2-instruct', label: 'Kimi K2 Instruct', provider: 'fireworks', contextWindow: 131_072, tools: true },
  // GitHub Copilot (device-flow OAuth, subscription-routed to multiple backends).
  { key: 'github-copilot:claude-sonnet-4-6', id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'github-copilot', contextWindow: 1_000_000, tools: true, vision: true, reasoning: true },
  { key: 'github-copilot:gpt-5', id: 'gpt-5', label: 'GPT-5', provider: 'github-copilot', contextWindow: 400_000, tools: true, vision: true, reasoning: true },
  { key: 'github-copilot:gpt-5-mini', id: 'gpt-5-mini', label: 'GPT-5 mini', provider: 'github-copilot', contextWindow: 400_000, tools: true, vision: true, reasoning: true },
  { key: 'github-copilot:gemini-2.5-pro', id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'github-copilot', contextWindow: 1_048_576, tools: true, vision: true, reasoning: true },
  { key: 'github-copilot:o4-mini', id: 'o4-mini', label: 'o4-mini', provider: 'github-copilot', contextWindow: 200_000, tools: true, reasoning: true },
  // Google Vertex AI (ADC-authenticated, enterprise GCP).
  { key: 'google-vertex:gemini-2.5-pro', id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'google-vertex', contextWindow: 1_048_576, tools: true, vision: true, reasoning: true },
  { key: 'google-vertex:gemini-2.5-flash', id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'google-vertex', contextWindow: 1_048_576, tools: true, vision: true, reasoning: true },
  { key: 'google-vertex:claude-sonnet-4-6@anthropic', id: 'claude-sonnet-4-6@anthropic', label: 'Claude Sonnet 4.6 (via Vertex)', provider: 'google-vertex', contextWindow: 1_000_000, tools: true, vision: true, reasoning: true },
  // Amazon Bedrock (AWS SigV4-authenticated).
  { key: 'amazon-bedrock:anthropic.claude-sonnet-4-6-v1:0', id: 'anthropic.claude-sonnet-4-6-v1:0', label: 'Claude Sonnet 4.6', provider: 'amazon-bedrock', contextWindow: 1_000_000, tools: true, vision: true, reasoning: true },
  { key: 'amazon-bedrock:anthropic.claude-haiku-4-5-v1:0', id: 'anthropic.claude-haiku-4-5-v1:0', label: 'Claude Haiku 4.5', provider: 'amazon-bedrock', contextWindow: 200_000, tools: true, vision: true, reasoning: true },
  { key: 'amazon-bedrock:amazon.nova-pro-v1:0', id: 'amazon.nova-pro-v1:0', label: 'Amazon Nova Pro', provider: 'amazon-bedrock', contextWindow: 300_000, tools: true, vision: true },
  // GitLab Duo (PAT-authenticated, proxied to Anthropic/OpenAI).
  { key: 'gitlab-duo:claude-sonnet-4-6', id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'gitlab-duo', contextWindow: 1_000_000, tools: true, vision: true, reasoning: true },
  { key: 'gitlab-duo:claude-haiku-4-5', id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'gitlab-duo', contextWindow: 200_000, tools: true, vision: true, reasoning: true },
  { key: 'gitlab-duo:gpt-5', id: 'gpt-5', label: 'GPT-5', provider: 'gitlab-duo', contextWindow: 400_000, tools: true, vision: true, reasoning: true },
  { key: 'gitlab-duo:gpt-5-mini', id: 'gpt-5-mini', label: 'GPT-5 mini', provider: 'gitlab-duo', contextWindow: 400_000, tools: true, vision: true, reasoning: true },
  // Azure OpenAI (API-key + endpoint).
  { key: 'azure-openai:gpt-5', id: 'gpt-5', label: 'GPT-5', provider: 'azure-openai', contextWindow: 400_000, tools: true, vision: true, reasoning: true },
  { key: 'azure-openai:gpt-5-mini', id: 'gpt-5-mini', label: 'GPT-5 mini', provider: 'azure-openai', contextWindow: 400_000, tools: true, vision: true, reasoning: true },
  { key: 'azure-openai:gpt-4.1', id: 'gpt-4.1', label: 'GPT-4.1', provider: 'azure-openai', contextWindow: 1_047_576, tools: true, vision: true },
];
