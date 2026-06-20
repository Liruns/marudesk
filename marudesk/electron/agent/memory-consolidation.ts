import { generateText } from 'ai';
import type { ProviderId } from '../../shared/providers';
import { isProviderId } from '../../shared/providers';
import type { SessionWorkspaceFilter } from './sessions-store';
import { listSessions, readSession } from './sessions-store';
import { resolveProviderAuth } from './resolve-auth';
import { buildModel, humanizeModelError } from './model';
import { writeMemory, readMemory } from './memory-store';
import { CONSOLIDATED_MEMORY_NAME } from './prompts.ts';
import {
  selectSessionsForConsolidation,
  buildConsolidationPrompt,
  assembleConsolidatedNote,
  MAX_CONSOLIDATED_SESSIONS,
  type ConsolidationSession,
} from './memory-consolidation-core.ts';

/**
 * Two-phase memory consolidation (SECOND-PASS: gajae memories/index.ts). marudesk
 * memory is otherwise manual KV (write_memory / read_memory); this adds an OPT-IN
 * pass that distills the user's recent past sessions — via one bounded model call,
 * the COMPACT-style single-`generateText` infra — into a single consolidated
 * "context" memory note a future session can be injected with.
 *
 * Simplified from gajae's SQLite-queue design to marudesk's JSON session store +
 * the existing on-disk memory store: read recent sessions, distill, write ONE
 * dedicated note ({@link CONSOLIDATED_MEMORY_NAME}). Non-destructive — it writes
 * only its own note and never touches the user's hand-authored memory entries.
 *
 * The injection side is intentionally minimal here (the note lands in the same
 * memory store the agent already reads via read_memory / list_memory; a future
 * slice can auto-fold it into the system prompt). The distill + store core is the
 * verifiable part and lives behind the pure helpers in memory-consolidation-core.
 */

const DISTILL_MAX_TOKENS = 1024;

export type ConsolidationResult =
  | { ok: true; note: string; sessionCount: number; memoryName: string }
  | { ok: false; reason: string };

/**
 * Run a consolidation pass over the most recent sessions (optionally scoped to a
 * workspace) and write the distilled note. Opt-in: nothing calls this on its own —
 * a Settings action / a future idle trigger invokes it explicitly. Provider/model
 * are supplied by the caller (typically the active conversation's) so the pass
 * uses an authenticated provider. Returns the written note, or a reason it didn't.
 */
export async function consolidateMemory(opts: {
  provider: ProviderId;
  model: string;
  workspaceId?: SessionWorkspaceFilter;
  now?: number;
}): Promise<ConsolidationResult> {
  if (!isProviderId(opts.provider) || !opts.model) {
    return { ok: false, reason: 'a provider and model are required to consolidate memory' };
  }
  // Read the most recent sessions (summaries first, then full records for content).
  const summaries = await listSessions(opts.workspaceId, MAX_CONSOLIDATED_SESSIONS);
  if (summaries.length === 0) {
    return { ok: false, reason: 'no past sessions to consolidate' };
  }
  const sessions: ConsolidationSession[] = [];
  for (const summary of summaries) {
    const record = await readSession(summary.id);
    if (!record) continue;
    sessions.push({
      id: record.id,
      title: record.title,
      updatedAt: record.updatedAt,
      messages: record.messages ?? [],
    });
  }
  const selected = selectSessionsForConsolidation(sessions);
  const prompt = buildConsolidationPrompt(selected);
  if (!prompt) {
    return { ok: false, reason: 'the recent sessions had nothing to consolidate' };
  }

  try {
    const resolved = await resolveProviderAuth(opts.provider);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    const model = buildModel(opts.provider, opts.model, resolved.auth, resolved.baseUrl);
    const res = await generateText({ model, prompt, maxOutputTokens: DISTILL_MAX_TOKENS });
    const distilled = res.text.trim();
    if (!distilled) return { ok: false, reason: 'the model returned an empty consolidation' };
    const note = assembleConsolidatedNote(distilled, selected.length, opts.now ?? Date.now());
    const write = await writeMemory(CONSOLIDATED_MEMORY_NAME, note);
    if (!write.ok) return { ok: false, reason: write.reason ?? 'failed to write the consolidated memory note' };
    return { ok: true, note, sessionCount: selected.length, memoryName: write.name };
  } catch (err) {
    return { ok: false, reason: humanizeModelError(err, opts.provider, opts.model) };
  }
}

/**
 * The consolidated note's current body, or null when no consolidation has run yet.
 * The minimal injection seam — a future slice can fold this into the system prompt
 * at turn start; for now the agent reaches it through its existing read_memory tool.
 */
export async function readConsolidatedMemory(): Promise<string | null> {
  const entry = await readMemory(CONSOLIDATED_MEMORY_NAME);
  return entry ? entry.body : null;
}
