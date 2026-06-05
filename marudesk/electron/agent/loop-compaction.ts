import { generateText } from 'ai';
import { isProviderId } from '../../shared/providers';
import { CLAUDE_CODE_SYSTEM_PREFIX } from '../oauth/config';
import { buildModel, humanizeModelError } from './model';
import { resolveProviderAuth } from './resolve-auth';
import { SUMMARY_PREFIX, COMPACT_INSTRUCTION } from './prompts.ts';
import { serializeForCompaction, splitForTailPreservation, messageChars } from './compaction-utils.ts';
import { S, busy, emit, uid } from './loop-state.ts';
import { persistSession } from './loop-sessions.ts';

/**
 * `/compact` for the agent loop (claude-code / codex parity): summarize the older
 * head of the transcript with the conversation's own model and keep the recent
 * tail verbatim. Operates on the shared {@link S} container; extracted from
 * loop.ts. Non-destructive — only the model-facing transcript is replaced.
 */
const COMPACTION_TAIL_FRACTION = 0.3;

export async function compactConversation(focus?: string): Promise<{ ok: boolean; reason?: string }> {
  if (busy() || S.starting) return { ok: false, reason: 'a turn is already in progress' };
  if (!S.conversationProvider || !S.conversationModel || !isProviderId(S.conversationProvider)) {
    return { ok: false, reason: 'nothing to compact yet' };
  }
  if (S.transcript.length < 2) return { ok: false, reason: 'conversation is too short to compact' };
  const provider = S.conversationProvider;
  const model = S.conversationModel;
  S.starting = true;
  try {
    const resolved = await resolveProviderAuth(provider);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    const m = buildModel(provider, model, resolved.auth, resolved.baseUrl);
    const codexBackend = provider === 'openai-codex';
    const system =
      resolved.auth.mode === 'oauth' && provider === 'anthropic'
        ? CLAUDE_CODE_SYSTEM_PREFIX
        : undefined;
    const trimmedFocus = focus?.trim();
    const instruction = trimmedFocus
      ? `${COMPACT_INSTRUCTION}\n\nThe user asked you to preserve this in extra detail: ${trimmedFocus}`
      : COMPACT_INSTRUCTION;
    // Keep the recent turns verbatim; only summarize the older head. The tail is
    // snapped to a turn boundary so the rebuilt S.transcript stays valid.
    const { head, tail } = splitForTailPreservation(S.transcript, COMPACTION_TAIL_FRACTION);
    if (head.length === 0) return { ok: false, reason: 'conversation is too short to compact' };
    const convo = serializeForCompaction(head);
    const res = await generateText({
      model: m,
      system,
      prompt: `${instruction}\n\n<conversation>\n${convo}\n</conversation>`,
      maxOutputTokens: codexBackend ? undefined : 2048,
      providerOptions: codexBackend ? { openai: { store: false } } : undefined,
    });
    const summary = res.text.trim();
    if (!summary) return { ok: false, reason: 'the model returned an empty summary' };

    // Estimate the context tokens dropped: the share of the pre-compaction
    // context the summarized head accounted for. Drives the divider label and
    // the post-compaction gauge.
    const before = S.state.usage.contextTokens;
    const totalChars = head.reduce((n, x) => n + messageChars(x), 0) + tail.reduce((n, x) => n + messageChars(x), 0);
    const headChars = head.reduce((n, x) => n + messageChars(x), 0);
    const freed = before > 0 && totalChars > 0 ? Math.round(before * (headChars / totalChars)) : undefined;

    S.transcript = [
      { role: 'user', content: `${SUMMARY_PREFIX}\n${summary}` },
      { role: 'assistant', content: 'Understood — I have the summary above and will continue from here.' },
      ...tail,
    ];
    // Keep the visible scrollback intact; just mark where the model's memory was
    // condensed. The divider holds the summary so the user can expand it to see
    // exactly what the model carried forward.
    S.state.messages.push({
      id: uid('m'),
      role: 'assistant',
      parts: [{ type: 'compaction', summary, freedTokens: freed && freed > 0 ? freed : undefined }],
      timestamp: Date.now(),
    });
    // Reset cumulative billing counters; keep an estimate of the live context so
    // the gauge reflects the lighter window until the next turn measures it.
    S.state.usage = {
      inputTokens: 0,
      outputTokens: 0,
      contextTokens: before > 0 && freed ? Math.max(0, before - freed) : 0,
    };
    S.state.error = null;
    S.state.endNote = null;
    emit();
    if (S.conversationId) void persistSession().then(() => emit()).catch(() => {});
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: humanizeModelError(err, provider, model) };
  } finally {
    S.starting = false;
  }
}
