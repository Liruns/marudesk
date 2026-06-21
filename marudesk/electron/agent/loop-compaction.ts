import { generateText, type ModelMessage } from 'ai';
import { isProviderId } from '../../shared/providers';
import { CLAUDE_CODE_SYSTEM_PREFIX } from '../oauth/config';
import { buildModel, humanizeModelError } from './model';
import { resolveProviderAuth } from './resolve-auth';
import { SUMMARY_PREFIX, COMPACT_INSTRUCTION, COMPACT_UPDATE_INSTRUCTION } from './prompts.ts';
import {
  serializeForCompaction,
  splitForTailPreservation,
  pruneStaleToolOutputsInHead,
  messageChars,
  transcriptChars,
  extractFileManifest,
  formatFileManifest,
  stripFileManifest,
  repairToolPairs,
  applyPersistentNudge,
  stripPersistentNudge,
  POST_COMPACTION_MONITOR_COUNT,
} from './compaction-utils.ts';
import {
  containerBusy,
  emitContainer,
  uid,
  currentContainer as activeContainer,
  type ThreadContainer,
} from './loop-state.ts';
import { persistSession } from './loop-sessions.ts';

/**
 * `/compact` for the agent loop (claude-code / codex parity): summarize the older
 * head of the transcript with the conversation's own model and keep the recent
 * tail verbatim. Operates on the shared {@link S} container; extracted from
 * loop.ts. Non-destructive — only the model-facing transcript is replaced.
 */
const COMPACTION_TAIL_FRACTION = 0.3;

/**
 * Pull the text of a prior compaction summary out of a head message, if present.
 * A previous `/compact` rebuilds the transcript with a leading user message
 * `${SUMMARY_PREFIX}\n${summary}` (see below); detecting it lets a second+
 * compaction MERGE rather than re-derive (item 6). Returns undefined for any
 * other message shape.
 */
function priorSummaryText(m: ModelMessage | undefined): string | undefined {
  if (!m || m.role !== 'user' || typeof m.content !== 'string') return undefined;
  if (!m.content.startsWith(SUMMARY_PREFIX)) return undefined;
  // Drop any compaction-protected persistent-nudge block first: it's a live
  // operational note (a not-yet-acted-on recovery/loop nudge), not history, so it
  // must not be fed back into the summarizer as prose on a merge pass.
  const body = stripPersistentNudge(m.content.slice(SUMMARY_PREFIX.length).trim()).trim();
  return body.length > 0 ? body : undefined;
}

export async function compactConversation(
  focus?: string,
  S: ThreadContainer = activeContainer(),
  opts: { allowDuringTurn?: boolean } = {},
): Promise<{ ok: boolean; reason?: string; freedChars?: number }> {
  // Guard the TARGET container (the active one for /compact, or a just-finished
  // turn's container for auto-compact) — both busy + the per-container starting flag.
  // Preemptive mid-turn compaction (item 2) sets allowDuringTurn: it runs INSIDE
  // the turn that owns S and is awaited synchronously before the next model call,
  // so there's no concurrent mutation to guard against; S.starting still blocks a
  // second compaction (e.g. a /compact racing the same container).
  if (S.starting) return { ok: false, reason: 'a turn is already in progress' };
  if (!opts.allowDuringTurn && containerBusy(S)) {
    return { ok: false, reason: 'a turn is already in progress' };
  }
  if (!S.conversationProvider || !S.conversationModel || !isProviderId(S.conversationProvider)) {
    return { ok: false, reason: 'nothing to compact yet' };
  }
  if (S.transcript.length < 2) return { ok: false, reason: 'conversation is too short to compact' };
  const provider = S.conversationProvider;
  const model = S.conversationModel;
  // Snapshot the pre-rebuild transcript weight so the overflow handler can tell
  // whether this pass actually shrank anything (rank 15 no-progress detection).
  const charsBefore = transcriptChars(S.transcript);
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
    // Keep the recent turns verbatim; only summarize the older head. The tail is
    // snapped to a turn boundary so the rebuilt S.transcript stays valid.
    const { head, tail } = splitForTailPreservation(S.transcript, COMPACTION_TAIL_FRACTION);
    if (head.length === 0) return { ok: false, reason: 'conversation is too short to compact' };
    // Incremental/merge compaction (item 6): a second+ compaction left a prior
    // summary at the head of the transcript. Detect it so the model MERGES new
    // progress into it instead of re-deriving the whole history from scratch.
    const previousSummary = priorSummaryText(head[0]);
    const baseInstruction = previousSummary ? COMPACT_UPDATE_INSTRUCTION : COMPACT_INSTRUCTION;
    const trimmedFocus = focus?.trim();
    const instruction = trimmedFocus
      ? `${baseInstruction}\n\nThe user asked you to preserve this in extra detail: ${trimmedFocus}`
      : baseInstruction;
    // Staleness-aware pruning (COMPACT-1): before summarizing, drop the bulky
    // payload of superseded tool outputs in the head (re-read files, superseded
    // greps/diagnostics, reads invalidated by a later edit). In-place on `head`
    // only — edits, user text, and the verbatim tail are never touched, and
    // every tool-call keeps its paired tool-result.
    const pruned = pruneStaleToolOutputsInHead(head);
    if (pruned.prunedCount > 0) {
      console.debug(
        `[compaction] pruned ${pruned.prunedCount} stale tool output(s), ~${pruned.charsSaved} chars freed before summarization`,
      );
    }
    const convo = serializeForCompaction(head);
    // File-operation manifest (item 4): the exact files the head read vs.
    // modified, derived from its tool-calls, appended to the summary so the
    // resumed model immediately knows its working scope. Tool-calls aren't
    // touched by pruning, so this is accurate after the prune pass above.
    const manifest = formatFileManifest(extractFileManifest(head));
    // When merging into a prior summary, give the model the previous summary in
    // a `<previous-summary>` block AFTER the new conversation (the merge prompt
    // references that tag). On a first compaction this block is absent.
    const previousBlock = previousSummary
      ? `\n\n<previous-summary>\n${stripFileManifest(previousSummary)}\n</previous-summary>`
      : '';
    const res = await generateText({
      model: m,
      system,
      prompt: `${instruction}\n\n<conversation>\n${convo}\n</conversation>${previousBlock}`,
      maxOutputTokens: codexBackend ? undefined : 2048,
      providerOptions: codexBackend ? { openai: { store: false } } : undefined,
    });
    const modelSummary = res.text.trim();
    if (!modelSummary) return { ok: false, reason: 'the model returned an empty summary' };
    // Append the machine-readable manifest to the prose summary (item 4).
    const summary = manifest ? `${modelSummary}\n\n${manifest}` : modelSummary;

    // Estimate the context tokens dropped: the share of the pre-compaction
    // context the summarized head accounted for. Drives the divider label and
    // the post-compaction gauge.
    const before = S.state.usage.contextTokens;
    const totalChars = head.reduce((n, x) => n + messageChars(x), 0) + tail.reduce((n, x) => n + messageChars(x), 0);
    const headChars = head.reduce((n, x) => n + messageChars(x), 0);
    const freed = before > 0 && totalChars > 0 ? Math.round(before * (headChars / totalChars)) : undefined;

    // Tool-pair orphan recovery (item 1): dropping the head can leave the tail
    // with a tool-call whose result was summarized away (or a result whose call
    // was) — either orphan 400s the NEXT provider call. Repair so every
    // tool_use has a paired tool_result before the rebuilt transcript is live.
    const repaired = repairToolPairs([
      { role: 'user', content: `${SUMMARY_PREFIX}\n${summary}` },
      { role: 'assistant', content: 'Understood — I have the summary above and will continue from here.' },
      ...tail,
    ]);
    if (repaired.injectedResults > 0 || repaired.droppedResults > 0) {
      console.debug(
        `[compaction] tool-pair repair: injected ${repaired.injectedResults} placeholder result(s), dropped ${repaired.droppedResults} orphan result(s)`,
      );
    }
    // Carry a not-yet-acted-on recovery/loop nudge across the boundary as a
    // compaction-PROTECTED note on the leading summary message, so a mid-turn
    // preemptive compaction can't summarize it away before the model acts on it.
    // A null nudge is a no-op (and still strips any stale block re-derivation
    // could have re-introduced). Applied AFTER the summarizer ran, so the nudge
    // text is never itself summarized.
    S.transcript = applyPersistentNudge(repaired.messages, S.persistentNudge);
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
      // Cache-read is genuinely 0 against the freshly-rebuilt prefix until the
      // next call measures it; set it explicitly so the gauge doesn't show an
      // undefined cache-read against the populated context estimate.
      cachedInputTokens: 0,
    };
    S.state.error = null;
    S.state.endNote = null;
    // Mark the compaction time (preemptive cooldown, item 2) and (re)open the
    // post-compaction degradation monitor window (item 3) — a fresh summary
    // starts the streak over and arms the monitor for the next few responses.
    S.lastCompactionAt = Date.now();
    S.postCompactionEmptyStreak = 0;
    S.postCompactionMonitorRemaining = POST_COMPACTION_MONITOR_COUNT;
    emitContainer(S);
    if (S.conversationId) void persistSession(S).then(() => emitContainer(S)).catch(() => {});
    // Report the transcript-weight delta so a no-progress overflow compaction
    // (an un-shrinkable verbatim tail) can short-circuit instead of looping +
    // failing over with the same oversized prompt (rank 15).
    return { ok: true, freedChars: Math.max(0, charsBefore - transcriptChars(S.transcript)) };
  } catch (err) {
    return { ok: false, reason: humanizeModelError(err, provider, model) };
  } finally {
    S.starting = false;
  }
}
