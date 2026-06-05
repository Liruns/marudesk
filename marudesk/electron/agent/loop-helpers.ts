import { generateText } from 'ai';
import type { AgentSendInput } from '../../shared/agent';
import type { WorkspaceSummary } from '../../shared/workspace';
import { scrubText } from '../../shared/scrub';
import { getProvider, isBuiltinProviderId } from '../../shared/providers';
import { getTab } from '../browser/state';
import { CLAUDE_CODE_SYSTEM_PREFIX } from '../oauth/config';
import { buildModel, humanizeModelError } from './model';
import { resolveProviderAuth } from './resolve-auth';

/**
 * Stateless helpers for the agent loop (loop.ts): the model-message shape for a
 * tool result, the per-turn user-text builder, and the provider connection test.
 * None touch the loop's module state, so they live here to keep loop.ts focused
 * on the stateful drive loop.
 */

export type ToolResultPartLite = {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output: { type: 'text'; value: string } | { type: 'error-text'; value: string };
};

export function toolResult(
  callId: string,
  toolName: string,
  content: string,
  isError?: boolean,
): ToolResultPartLite {
  return {
    type: 'tool-result',
    toolCallId: callId,
    toolName,
    output: isError ? { type: 'error-text', value: content } : { type: 'text', value: content },
  };
}

export function buildUserText(
  input: AgentSendInput,
  ws: WorkspaceSummary | null,
  modePreambleText: string | null,
): string {
  const lines: string[] = [
    ws
      ? `Workspace: ${ws.name} (${ws.files.length} files indexed).`
      : 'No workspace is open — file tools (read/list/grep/edit) are unavailable. Browser and page tools (console/DOM/network/eval) work normally.',
  ];
  if (input.tabId) {
    const rec = getTab(input.tabId);
    const url = rec?.view?.webContents.getURL();
    // Scrub: URLs can carry tokens in query params (and captures carry page text).
    if (url) lines.push(`Active web tab URL: ${scrubText(url)}`);
  }
  // Keyword modes (e.g. "ulw"/ultrawork): steer the model via a prepended
  // preamble for every CURRENTLY-ACTIVE (sticky) mode. Applied to the
  // model-facing text only — the chat shows the original message unchanged.
  if (modePreambleText) lines.push('', modePreambleText);
  lines.push('', `User request: ${input.prompt.trim()}`);
  if (input.captures.length > 0) {
    lines.push('', 'Attached context (selected by the user):');
    for (const cap of input.captures) {
      if (cap.kind === 'console-error') {
        const loc = cap.source ? ` @ ${scrubText(cap.source.url)}` : '';
        lines.push(`- console error: ${scrubText(cap.message)}${loc}`);
      } else {
        const attrs = Object.entries(cap.attributes).slice(0, 6).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
        lines.push(`- <${cap.tagName.toLowerCase()}> selector="${cap.selector}"${cap.text ? ` text="${cap.text.slice(0, 80)}"` : ''}${attrs ? ` [${attrs}]` : ''}`);
      }
    }
    lines.push('', 'Use the tools to confirm against the live page and the workspace files.');
  }
  return lines.join('\n');
}

/* ── post-edit verify hook (claude-code / codex PostToolUse) ─────────────── */


export async function testProviderConnection(
  provider: AgentSendInput['provider'],
): Promise<{ ok: boolean; message: string }> {
  const resolved = await resolveProviderAuth(provider);
  if (!resolved.ok) return { ok: false, message: resolved.reason };
  const model = isBuiltinProviderId(provider) ? getProvider(provider).defaultModelId : '';
  if (!model) return { ok: false, message: 'No default model to test for this provider.' };
  try {
    const m = buildModel(provider, model, resolved.auth, resolved.baseUrl);
    const codexBackend = provider === 'openai-codex';
    const system =
      resolved.auth.mode === 'oauth' && provider === 'anthropic'
        ? CLAUDE_CODE_SYSTEM_PREFIX
        : undefined;
    await generateText({
      model: m,
      system,
      prompt: 'Reply with the single word: ok',
      maxOutputTokens: codexBackend ? undefined : 16,
      providerOptions: codexBackend ? { openai: { store: false } } : undefined,
    });
    return { ok: true, message: `Connection works — ${model} responded.` };
  } catch (err) {
    return { ok: false, message: humanizeModelError(err, provider, model) };
  }
}

