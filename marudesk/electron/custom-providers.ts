import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  customProviderId,
  parseCustomProviderId,
  type CustomProvider,
  type CustomProviderInfo,
  type CustomProviderInput,
  type ProviderId,
} from '../shared/providers';
import { defineHandler } from './ipc/define-handler';
import { arrayOf, nonEmptyStr, obj, optStr } from './ipc/validate';
import { clearProviderKey, hasProviderKey, setProviderKey } from './secrets';

/**
 * Custom OpenAI-compatible endpoints (OpenRouter / LM Studio / vLLM / Together /
 * Groq …) — docs/agentic-chat-v2-design.md §5, decisions D1/D3. The endpoint
 * *config* (label / baseURL / models) is not secret, so it lives in a plaintext
 * JSON file in userData; the optional API key is the only secret and is stored in
 * the encrypted creds vault under `custom:<id>` (electron/secrets.ts). The agent
 * resolves a `custom:<id>` selection to its baseURL here (electron/agent/loop.ts)
 * and builds the model via createOpenAICompatible (electron/agent/model.ts).
 */

const FILE = 'marudesk-custom-providers.json';

function filePath(): string {
  return path.join(app.getPath('userData'), FILE);
}

/** A stored entry validated back into a {@link CustomProvider} (the file is
 * plaintext and could be hand-edited, so trust nothing). */
function coerce(value: unknown): CustomProvider | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id.length === 0) return null;
  if (typeof v.label !== 'string' || v.label.length === 0) return null;
  if (typeof v.baseUrl !== 'string' || v.baseUrl.length === 0) return null;
  if (!Array.isArray(v.models)) return null;
  const models: CustomProvider['models'] = [];
  for (const m of v.models) {
    if (!m || typeof m !== 'object') continue;
    const mm = m as Record<string, unknown>;
    if (typeof mm.id !== 'string' || mm.id.length === 0) continue;
    models.push({
      id: mm.id,
      label: typeof mm.label === 'string' && mm.label.length > 0 ? mm.label : mm.id,
      contextWindow:
        typeof mm.contextWindow === 'number' && Number.isFinite(mm.contextWindow)
          ? mm.contextWindow
          : undefined,
      tools: typeof mm.tools === 'boolean' ? mm.tools : true,
    });
  }
  if (models.length === 0) return null;
  return { id: v.id, label: v.label, kind: 'openai-compatible', baseUrl: v.baseUrl, models };
}

async function loadCustom(): Promise<CustomProvider[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map(coerce).filter((c): c is CustomProvider => c !== null);
}

async function saveCustom(list: CustomProvider[]): Promise<void> {
  const file = filePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(list, null, 2), { mode: 0o600 });
}

/** Resolve a `custom:<id>` selection to its stored config (null when built-in or
 * unknown). Used by the agent loop to fetch the baseURL for the model call. */
export async function getCustomProvider(
  provider: ProviderId,
): Promise<CustomProvider | null> {
  const localId = parseCustomProviderId(provider);
  if (!localId) return null;
  const list = await loadCustom();
  return list.find((c) => c.id === localId) ?? null;
}

async function withStatus(list: CustomProvider[]): Promise<CustomProviderInfo[]> {
  return Promise.all(
    list.map(async (c) => ({ ...c, hasKey: await hasProviderKey(customProviderId(c.id)) })),
  );
}

/** "OpenRouter (free)" → "openrouter-free"; restricted so it embeds cleanly in
 * `custom:<id>` and a future URL/file path. Falls back to "endpoint". */
function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'endpoint';
}

function parseBaseUrl(value: unknown): string {
  const s = nonEmptyStr(value, 'baseUrl').trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new Error('baseUrl must be a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('baseUrl must be an http(s) URL');
  }
  return s;
}

function parseInput(payload: unknown): CustomProviderInput {
  const o = obj(payload);
  const modelIds = Array.from(
    new Set(arrayOf(o.modelIds, (x) => nonEmptyStr(x, 'modelId').trim(), 'modelIds')),
  );
  if (modelIds.length === 0) throw new Error('at least one model id is required');
  return {
    id: optStr(o.id, 'id')?.trim() || undefined,
    label: nonEmptyStr(o.label, 'label').trim(),
    baseUrl: parseBaseUrl(o.baseUrl),
    modelIds,
    apiKey: optStr(o.apiKey, 'apiKey'),
  };
}

async function addCustom(input: CustomProviderInput): Promise<CustomProviderInfo[]> {
  const id = slugify(input.id ?? input.label);
  const entry: CustomProvider = {
    id,
    label: input.label,
    kind: 'openai-compatible',
    baseUrl: input.baseUrl,
    models: input.modelIds.map((m) => ({ id: m, label: m, tools: true })),
  };
  const list = await loadCustom();
  const next = [...list.filter((c) => c.id !== id), entry];
  await saveCustom(next);
  // The key is the only secret — store it in the encrypted vault, keyed by the
  // same `custom:<id>` the agent path resolves against.
  const key = input.apiKey?.trim();
  if (key) await setProviderKey(customProviderId(id), key);
  return withStatus(next);
}

async function removeCustom(id: string): Promise<CustomProviderInfo[]> {
  const list = await loadCustom();
  const next = list.filter((c) => c.id !== id);
  await saveCustom(next);
  // Drop the orphaned key so a re-added endpoint of the same id starts clean.
  await clearProviderKey(customProviderId(id)).catch(() => {});
  return withStatus(next);
}

export function registerCustomProviderHandlers(): void {
  defineHandler('providers:list-custom', async () => withStatus(await loadCustom()));
  defineHandler('providers:add-custom', ([payload]) => addCustom(parseInput(payload)));
  defineHandler('providers:remove-custom', ([id]) => removeCustom(nonEmptyStr(id, 'id')));
}
