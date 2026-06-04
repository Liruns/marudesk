import type { ModelDef } from '../../shared/providers';
import type { ProviderDriver } from './types';
import { ProviderAuthError, isAuthStatus, prettifyId } from './tool';

async function listModels(apiKey: string): Promise<ModelDef[]> {
  const resp = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).slice(0, 200);
    const message = `OpenAI /v1/models returned HTTP ${resp.status}: ${detail}`;
    if (isAuthStatus(resp.status)) throw new ProviderAuthError(message, resp.status);
    throw new Error(message);
  }
  const json = (await resp.json()) as { data?: { id: string }[] };
  const items = json.data ?? [];
  // Keep chat and media-generation families, while avoiding embedding/whisper/TTS noise.
  const keep = (id: string): boolean =>
    /^(gpt-|o\d|chatgpt|claude-|dall-e-|sora-2)/i.test(id) &&
    !/embedding|whisper|tts/i.test(id);
  return items
    .filter((m) => typeof m.id === 'string' && keep(m.id))
    .map((m) => ({ id: m.id, label: prettifyId(m.id) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export const openaiDriver: ProviderDriver = { listModels };
