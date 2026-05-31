import type { ModelDef } from '../../shared/providers';
import type { ProviderDriver } from './types';
import { ProviderAuthError, isAuthStatus, prettifyId } from './tool';

async function listModels(apiKey: string): Promise<ModelDef[]> {
  const resp = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
    { headers: { 'x-goog-api-key': apiKey } },
  );
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).slice(0, 200);
    const message = `Gemini /v1beta/models returned HTTP ${resp.status}: ${detail}`;
    // Gemini reports a bad key as 400 API_KEY_INVALID rather than 401.
    const badKey =
      isAuthStatus(resp.status) ||
      (resp.status === 400 && /api[_ ]?key/i.test(detail));
    if (badKey) throw new ProviderAuthError(message, resp.status);
    throw new Error(message);
  }
  const json = (await resp.json()) as {
    models?: {
      name: string;
      displayName?: string;
      supportedGenerationMethods?: string[];
    }[];
  };
  const items = json.models ?? [];
  const out: ModelDef[] = [];
  for (const m of items) {
    if (typeof m.name !== 'string') continue;
    const methods = m.supportedGenerationMethods ?? [];
    if (!methods.includes('generateContent')) continue;
    // name comes as "models/gemini-2.5-pro" — strip the prefix.
    const id = m.name.replace(/^models\//, '');
    if (!id.startsWith('gemini-')) continue;
    out.push({ id, label: m.displayName?.trim() || prettifyId(id) });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export const googleDriver: ProviderDriver = { listModels };
