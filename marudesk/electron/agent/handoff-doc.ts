import { HANDOFF_INSTRUCTION, HANDOFF_SEED_PREFIX } from './prompts.ts';

/**
 * Pure handoff-document assembly (SECOND-PASS session handoff), factored out of
 * handoff.ts so it stays dependency-free (no `ai` / Electron / model wiring) and
 * can be unit-tested in the plain-node handoff harness. handoff.ts wires these
 * into the live single-`generateText` call; nothing here touches process state.
 */

/** A model handoff document plus the raw brief before the manifest was appended. */
export type HandoffDoc = {
  /** The full self-contained markdown handoff document (model brief + manifest). */
  document: string;
  /** The raw model brief, before the file manifest was appended. */
  summary: string;
};

/**
 * Build the single-shot prompt sent to the model for a handoff. Pure: the
 * conversation is already serialized to a textual trace. An optional `focus` is
 * folded in exactly as `/compact` folds its focus, so the user can ask the handoff
 * to preserve a specific thread of work in extra detail.
 */
export function buildHandoffPrompt(serializedConversation: string, focus?: string): string {
  const trimmedFocus = focus?.trim();
  const instruction = trimmedFocus
    ? `${HANDOFF_INSTRUCTION}\n\nThe user asked you to preserve this in extra detail: ${trimmedFocus}`
    : HANDOFF_INSTRUCTION;
  return `${instruction}\n\n<conversation>\n${serializedConversation}\n</conversation>`;
}

/**
 * Assemble the final handoff document from the model's brief and the transcript's
 * file manifest. Pure — the manifest (read vs. modified files) is appended verbatim
 * under a machine-readable tail so the fresh session knows the working scope
 * immediately, exactly as the compaction summary does. Returns the model brief
 * unchanged when there were no file operations to list.
 */
export function assembleHandoffDoc(modelSummary: string, manifest: string): HandoffDoc {
  const summary = modelSummary.trim();
  const document = manifest ? `${summary}\n\n${manifest}` : summary;
  return { document, summary };
}

/**
 * The first user message that SEEDS a fresh session from a handoff document. Pure
 * — prefixes the document with {@link HANDOFF_SEED_PREFIX} so the fresh model reads
 * it as context-to-continue rather than as a task to summarize again.
 */
export function buildHandoffSeed(document: string): string {
  return `${HANDOFF_SEED_PREFIX}\n\n<handoff>\n${document.trim()}\n</handoff>`;
}
