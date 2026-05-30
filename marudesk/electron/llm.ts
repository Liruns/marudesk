import path from 'node:path';
import type {
  CapturePayload,
  ProposeInput,
  ProposeResult,
} from '../shared/composer';
import {
  isProviderId,
  type ProviderDef,
  type ProviderId,
  getProvider,
} from '../shared/providers';
import type { WorkspaceSummary } from '../shared/workspace';
import { urlToWorkspacePath } from '../shared/runtime-evidence';
import { getProviderApiKey } from './secrets';
import { rankFiles, readFileSafe } from './workspace';
import { defineHandler, requireWorkspace } from './ipc/define-handler';
import { DRIVERS } from './providers';

const TOP_FILES_PER_CAPTURE = 3;
const MAX_FILE_CHARS = 16_000;
const MAX_OUTER_HTML_CHARS = 2_000;
const MAX_STACK_FRAMES = 12;

function isStackFrameLite(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.functionName === 'string' &&
    typeof f.url === 'string' &&
    typeof f.lineNumber === 'number' &&
    typeof f.columnNumber === 'number'
  );
}

function isCapturePayload(value: unknown): value is CapturePayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id.length === 0) return false;
  if (typeof v.url !== 'string') return false;

  if (v.kind === 'console-error') {
    if (typeof v.message !== 'string') return false;
    if (!Array.isArray(v.stack) || !v.stack.every(isStackFrameLite)) return false;
    if (v.source !== undefined) {
      if (!v.source || typeof v.source !== 'object') return false;
      const s = v.source as Record<string, unknown>;
      if (typeof s.url !== 'string') return false;
      if (s.lineNumber !== undefined && typeof s.lineNumber !== 'number') return false;
    }
    return true;
  }

  if (v.kind === 'element') {
    if (typeof v.tagName !== 'string') return false;
    if (typeof v.selector !== 'string') return false;
    if (typeof v.text !== 'string') return false;
    if (!v.attributes || typeof v.attributes !== 'object') return false;
    for (const val of Object.values(v.attributes as Record<string, unknown>)) {
      if (typeof val !== 'string') return false;
    }
    // Optional richer context from the DevTools picker.
    if (v.outerHTML !== undefined && typeof v.outerHTML !== 'string') return false;
    if (v.computedStyle !== undefined) {
      if (!v.computedStyle || typeof v.computedStyle !== 'object') return false;
      for (const val of Object.values(v.computedStyle as Record<string, unknown>)) {
        if (typeof val !== 'string') return false;
      }
    }
    return true;
  }

  return false; // unknown kind
}

function isProposeInput(value: unknown): value is ProposeInput {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!isProviderId(v.provider)) return false;
  if (typeof v.model !== 'string' || v.model.length === 0) return false;
  if (typeof v.prompt !== 'string' || v.prompt.trim().length === 0) return false;
  if (!Array.isArray(v.captures)) return false;
  return v.captures.every(isCapturePayload);
}

function clipFileText(text: string): { body: string; truncated: boolean } {
  if (text.length <= MAX_FILE_CHARS) {
    return { body: text, truncated: false };
  }
  return { body: text.slice(0, MAX_FILE_CHARS), truncated: true };
}

function formatAttributes(attrs: Record<string, string>): string {
  const entries = Object.entries(attrs);
  if (entries.length === 0) return '(none)';
  return entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
}

function escapeFence(text: string): string {
  return text.replace(/```/g, '``​`');
}

/** `{url, lineNumber}` → `path:1-based-line` (CDP line numbers are 0-based). */
function formatSourceLoc(source: { url: string; lineNumber?: number }): string {
  let p = source.url;
  try {
    p = new URL(source.url).pathname || source.url;
  } catch {
    // keep the raw URL
  }
  return source.lineNumber !== undefined ? `${p}:${source.lineNumber + 1}` : p;
}

/**
 * Deterministically resolve the workspace file a console error points at:
 * walk the stack (innermost-first), then the source location, mapping each URL
 * to a workspace path (same-origin → pathname) and returning the first that
 * actually reads. No fuzzy `rankFiles` — the stack URL *is* the answer when the
 * dev server serves real files. Returns null when nothing maps (bundled / Vite
 * virtual / cross-origin / node_modules).
 */
async function resolveErrorSourceFile(
  ws: WorkspaceSummary,
  cap: { url: string; stack: { url: string }[]; source?: { url: string } },
): Promise<{ path: string; content: string } | null> {
  let origin: string;
  try {
    origin = new URL(cap.url).origin;
  } catch {
    return null;
  }
  const urls = [...cap.stack.map((f) => f.url)];
  if (cap.source?.url) urls.push(cap.source.url);
  const seen = new Set<string>();
  for (const u of urls) {
    const rel = u ? urlToWorkspacePath(u, origin) : null;
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    try {
      const content = await readFileSafe(ws.root, rel);
      return { path: rel, content };
    } catch {
      // Not a readable workspace file — try the next frame.
    }
  }
  return null;
}

async function buildUserMessage(
  ws: WorkspaceSummary,
  input: ProposeInput,
): Promise<string> {
  const parts: string[] = [];
  parts.push(`Workspace: ${ws.name} (${ws.files.length} files indexed)`);
  parts.push(`User prompt: ${input.prompt.trim()}`);
  parts.push('');

  const filesIncluded = new Map<string, { matches: string[]; score: number }>();

  for (let i = 0; i < input.captures.length; i++) {
    const cap = input.captures[i];

    if (cap.kind === 'console-error') {
      parts.push(`--- capture #${i + 1} (console error) ---`);
      parts.push(`url: ${cap.url}`);
      parts.push(`error: ${cap.message}`);
      if (cap.source) parts.push(`location: ${formatSourceLoc(cap.source)}`);
      if (cap.stack.length > 0) {
        parts.push('stack (innermost first):');
        for (const f of cap.stack.slice(0, MAX_STACK_FRAMES)) {
          const where = f.url ? ` ${formatSourceLoc({ url: f.url, lineNumber: f.lineNumber })}` : '';
          parts.push(`  at ${f.functionName || '(anonymous)'}${where}`);
        }
      }
      const resolved = await resolveErrorSourceFile(ws, cap);
      if (resolved) {
        parts.push(
          `resolved source file: ${resolved.path} (line numbers above are the served/transpiled file — may differ from source)`,
        );
        if (!filesIncluded.has(resolved.path)) {
          filesIncluded.set(resolved.path, {
            matches: ['console-error stack'],
            score: 0,
          });
        }
      } else {
        parts.push(
          'resolved source file: (none — the stack did not map to a workspace file)',
        );
      }
      parts.push('');
      continue;
    }

    parts.push(`--- capture #${i + 1} ---`);
    parts.push(`url: ${cap.url}`);
    parts.push(`tag: <${cap.tagName.toLowerCase()}>`);
    parts.push(`selector: ${cap.selector || '(none)'}`);
    parts.push(`attributes: ${formatAttributes(cap.attributes)}`);
    if (cap.text) {
      const t = cap.text.length > 400 ? cap.text.slice(0, 400) + '…' : cap.text;
      parts.push(`text: ${t}`);
    }
    if (cap.computedStyle) {
      const entries = Object.entries(cap.computedStyle);
      if (entries.length > 0) {
        parts.push(
          `computed style: ${entries.map(([k, val]) => `${k}: ${val}`).join('; ')}`,
        );
      }
    }
    if (cap.outerHTML) {
      const h =
        cap.outerHTML.length > MAX_OUTER_HTML_CHARS
          ? cap.outerHTML.slice(0, MAX_OUTER_HTML_CHARS) + '…'
          : cap.outerHTML;
      parts.push('outerHTML:');
      parts.push('```html');
      parts.push(escapeFence(h));
      parts.push('```');
    }
    parts.push('');

    const ranked = await rankFiles(
      ws.root,
      {
        tagName: cap.tagName,
        selector: cap.selector,
        text: cap.text,
        attributes: cap.attributes,
      },
      ws.files,
    );
    const top = ranked.slice(0, TOP_FILES_PER_CAPTURE);
    if (top.length === 0) {
      parts.push('ranked source files: (none)');
      parts.push('');
      continue;
    }
    parts.push(`ranked source files (top ${top.length}):`);
    for (const r of top) {
      parts.push(`- ${r.path} (score ${r.score}, matches: ${r.matches.join(', ')})`);
      const existing = filesIncluded.get(r.path);
      if (!existing || r.score > existing.score) {
        filesIncluded.set(r.path, { matches: r.matches, score: r.score });
      }
    }
    parts.push('');
  }

  if (filesIncluded.size === 0) {
    parts.push('No workspace files were judged relevant. Return ops: [].');
    return parts.join('\n');
  }

  parts.push('--- candidate files ---');
  parts.push(
    'Each block contains the current contents you may edit. Only emit edits referencing these paths.',
  );
  parts.push('');

  for (const [rel] of filesIncluded) {
    let content: string;
    try {
      content = await readFileSafe(ws.root, rel);
    } catch (err) {
      parts.push(`### ${rel}`);
      parts.push(`(unreadable: ${(err as Error).message})`);
      parts.push('');
      continue;
    }
    const ext = path.extname(rel).replace(/^\./, '') || 'txt';
    const { body, truncated } = clipFileText(content);
    parts.push(`### ${rel}`);
    parts.push('```' + ext);
    parts.push(escapeFence(body));
    parts.push('```');
    if (truncated) {
      parts.push(`(truncated to ${MAX_FILE_CHARS} chars)`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

// ---------- Dispatcher ----------

async function proposePatch(
  ws: WorkspaceSummary,
  input: ProposeInput,
): Promise<ProposeResult> {
  let provider: ProviderDef;
  try {
    provider = getProvider(input.provider);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  // Model validity is delegated to the provider API; a bad ID surfaces as a
  // 404/400 from the upstream call which is more accurate than a hard-coded
  // catalog filter (models ship and deprecate continuously).
  let apiKey: string | null;
  try {
    apiKey = await getProviderApiKey(input.provider);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  if (!apiKey) {
    return {
      ok: false,
      reason: `no API key configured for ${provider.label}; open Providers settings`,
    };
  }

  let userText: string;
  try {
    userText = await buildUserMessage(ws, input);
  } catch (err) {
    return {
      ok: false,
      reason: `failed to build context: ${(err as Error).message}`,
    };
  }

  return DRIVERS[provider.id].propose(apiKey, input.model, userText);
}

export function registerLlmHandlers(): void {
  defineHandler('llm:propose-patch', async ([payload]) => {
    if (!isProposeInput(payload)) {
      console.warn('[llm] invalid propose payload shape', payload);
      throw new Error(
        'payload must be { provider, model, prompt, captures }',
      );
    }
    if (payload.captures.length === 0) {
      throw new Error('at least one capture is required');
    }
    const { ws } = requireWorkspace();
    console.log(
      `[llm] propose start provider=${payload.provider} model=${payload.model} captures=${payload.captures.length} promptLen=${payload.prompt.length}`,
    );
    const result = await proposePatch(ws, payload);
    if (result.ok) {
      console.log(
        `[llm] propose ok ops=${result.ops.length} in=${result.usage.inputTokens} out=${result.usage.outputTokens}`,
      );
    } else {
      console.warn(`[llm] propose fail reason=${result.reason}`);
    }
    return result;
  });
}

// Re-export used types for downstream consumers.
export type { ProviderId };
