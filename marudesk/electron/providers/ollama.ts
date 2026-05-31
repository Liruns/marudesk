import type { ModelDef } from '../../shared/providers';
import type { ProviderDriver } from './types';

/**
 * Ollama (roadmap P3) — a local, keyless provider exposing an OpenAI-compatible
 * API at localhost:11434. Generation now runs through the Vercel AI SDK
 * (electron/agent/model.ts); this driver only contributes the live model list
 * from Ollama's native tag endpoint (no auth). Tool-capable local models (e.g.
 * qwen2.5-coder) are the ones usable by the agent.
 */

export const OLLAMA_BASE = 'http://localhost:11434';

async function listModels(): Promise<ModelDef[]> {
  // Ollama's native tag list (no auth). Empty/unreachable → caller falls back to
  // the static catalog.
  const resp = await fetch(`${OLLAMA_BASE}/api/tags`);
  if (!resp.ok) {
    throw new Error(`Ollama /api/tags returned HTTP ${resp.status}`);
  }
  const json = (await resp.json()) as { models?: { name?: string }[] };
  return (json.models ?? [])
    .map((m) => m.name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
    .map((name) => ({ id: name, label: name }));
}

export const ollamaDriver: ProviderDriver = { listModels };
