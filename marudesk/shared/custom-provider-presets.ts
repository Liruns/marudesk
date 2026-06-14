/**
 * Curated quick-setup presets for the "Add custom endpoint" form. Each is an
 * OpenAI-compatible endpoint (Bearer key + `/v1/chat/completions` + `/models`)
 * that marudesk reaches via `createOpenAICompatible` — the same path as the
 * built-in OpenAI-compatible providers. Picking one prefills the form's
 * name/base URL/seed models so a user doesn't have to hunt the endpoint down;
 * the live `/models` fetch refreshes the seed once a key is saved.
 *
 * Base URLs are taken from working configs in the reference catalog
 * (Yeachan-Heo/gajae-code · packages/ai · models.json / provider-onboarding) and
 * each provider's own docs. We list only endpoints that are NOT already
 * first-class built-ins (see provider-catalog.ts) plus the common local
 * runtimes, so the presets complement rather than duplicate the built-in list.
 */
export type CustomEndpointPreset = {
  /** Stable id (used as a React key + e2e hook). */
  id: string;
  /** Display name; also seeds the endpoint's label. */
  label: string;
  /** OpenAI-compatible base URL (no trailing slash). */
  baseUrl: string;
  /** Seed model ids; empty when the catalog is too large/arbitrary to seed. */
  models: readonly string[];
  /** Console URL to issue a key (omitted for keyless local runtimes). */
  apiKeyUrl?: string;
  /** Local runtime that needs no key (LM Studio / Ollama / vLLM / LiteLLM). */
  local?: boolean;
};

export const CUSTOM_ENDPOINT_PRESETS: readonly CustomEndpointPreset[] = [
  // Local OpenAI-compatible runtimes — no key; the user supplies the model id(s)
  // they've actually loaded/served.
  { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', models: [], local: true },
  { id: 'ollama-openai', label: 'Ollama (OpenAI API)', baseUrl: 'http://localhost:11434/v1', models: [], local: true },
  { id: 'vllm', label: 'vLLM', baseUrl: 'http://localhost:8000/v1', models: [], local: true },
  { id: 'litellm', label: 'LiteLLM', baseUrl: 'http://localhost:4000/v1', models: [], local: true },

  // Cloud OpenAI-compatible gateways not covered by a built-in provider.
  {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.ai/v1',
    models: ['kimi-k2.5'],
    apiKeyUrl: 'https://platform.moonshot.ai/console/api-keys',
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    baseUrl: 'https://router.huggingface.co/v1',
    models: ['deepseek-ai/DeepSeek-V3.1'],
    apiKeyUrl: 'https://huggingface.co/settings/tokens',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: [],
    apiKeyUrl: 'https://build.nvidia.com',
  },
  {
    id: 'venice',
    label: 'Venice',
    baseUrl: 'https://api.venice.ai/api/v1',
    models: [],
    apiKeyUrl: 'https://venice.ai/settings/api',
  },
  {
    // marudesk's built-in `zai` targets the standard paas/v4 endpoint; a GLM
    // Coding Plan key is scoped to a different base URL (see provider-catalog.ts
    // zai note), so it belongs here as a custom endpoint.
    id: 'glm-coding-plan',
    label: 'GLM Coding Plan',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    models: ['glm-4.6'],
    apiKeyUrl: 'https://z.ai/manage-apikey/apikey-list',
  },
];
