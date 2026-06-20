import { generateText, type ModelMessage } from 'ai';
import { isProviderId } from '../../shared/providers';
import { CLAUDE_CODE_SYSTEM_PREFIX } from '../oauth/config';
import { buildModel, humanizeModelError } from './model';
import { resolveProviderAuth } from './resolve-auth';
import { assembleHandoffDoc, buildHandoffPrompt } from './handoff-doc.ts';
import {
  serializeForCompaction,
  extractFileManifest,
  formatFileManifest,
} from './compaction-utils.ts';
import {
  containerBusy,
  currentContainer as activeContainer,
  type ThreadContainer,
} from './loop-state.ts';

/**
 * Session handoff (SECOND-PASS: gajae handoff-generation-pipeline.md). Before the
 * context limit forces a fresh start, the user can mint an explicit checkpoint: an
 * LLM summary "handoff" document of the LIVE transcript that a brand-new session
 * can be seeded with, so nothing learned this session is lost on a clean restart.
 *
 * This reuses the SAME COMPACT-style single-`generateText` infra the compaction
 * path uses (one bounded model call, the conversation's own model), but with the
 * handoff-specific {@link HANDOFF_INSTRUCTION} (a fuller self-contained brief
 * rather than a terse context-replacement summary). The pure assembly helpers live
 * in handoff-doc.ts (Electron-free) so the handoff harness can assert the doc shape
 * and the fresh-session seed without a live model.
 */

// Re-export the pure assembly helpers so the loop seeding path + the IPC layer can
// import everything handoff-related from this module.
export { buildHandoffPrompt, assembleHandoffDoc, buildHandoffSeed } from './handoff-doc.ts';
export type { HandoffDoc } from './handoff-doc.ts';

/** The result of a handoff request (handoff IPC / `/handoff` command). */
export type HandoffResult =
  | { ok: true; document: string; summary: string }
  | { ok: false; reason: string };

/**
 * Generate a handoff document from a thread's live transcript with the
 * conversation's own model. Mirrors {@link compactConversation}'s model wiring
 * (auth resolve → buildModel → one bounded generateText) but is fully
 * non-destructive: it READS S.transcript and returns the document, never mutating
 * loop state. Refuses while a turn is in flight, when there's no provider/model
 * yet, or when the conversation is too short to be worth a handoff.
 */
export async function generateHandoff(
  focus?: string,
  S: ThreadContainer = activeContainer(),
): Promise<HandoffResult> {
  if (containerBusy(S)) return { ok: false, reason: 'a turn is already in progress' };
  if (!S.conversationProvider || !S.conversationModel || !isProviderId(S.conversationProvider)) {
    return { ok: false, reason: 'nothing to hand off yet' };
  }
  if (S.transcript.length < 2) {
    return { ok: false, reason: 'conversation is too short to hand off' };
  }
  const provider = S.conversationProvider;
  const model = S.conversationModel;
  // Snapshot the transcript up front so a (guarded-against, but defensive) mid-call
  // mutation can't change what we summarized.
  const transcript: ModelMessage[] = [...S.transcript];
  try {
    const resolved = await resolveProviderAuth(provider);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    const m = buildModel(provider, model, resolved.auth, resolved.baseUrl);
    const codexBackend = provider === 'openai-codex';
    const system =
      resolved.auth.mode === 'oauth' && provider === 'anthropic'
        ? CLAUDE_CODE_SYSTEM_PREFIX
        : undefined;
    const convo = serializeForCompaction(transcript);
    const manifest = formatFileManifest(extractFileManifest(transcript));
    const res = await generateText({
      model: m,
      system,
      prompt: buildHandoffPrompt(convo, focus),
      maxOutputTokens: codexBackend ? undefined : 2048,
      providerOptions: codexBackend ? { openai: { store: false } } : undefined,
    });
    const modelSummary = res.text.trim();
    if (!modelSummary) return { ok: false, reason: 'the model returned an empty handoff' };
    const { document, summary } = assembleHandoffDoc(modelSummary, manifest);
    return { ok: true, document, summary };
  } catch (err) {
    return { ok: false, reason: humanizeModelError(err, provider, model) };
  }
}
