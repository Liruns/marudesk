import type { AgentMessage } from '../../shared/agent';
import { MEMORY_CONSOLIDATION_INSTRUCTION } from './prompts.ts';

/**
 * Pure helpers for two-phase memory consolidation (SECOND-PASS: gajae
 * memories/index.ts), factored out of memory-consolidation.ts so they stay
 * dependency-free (no `ai` / Electron / fs) and are unit-testable in the bare
 * memory-consolidation harness. The orchestrator wires these into the recent-
 * session read, the single distill model call, and the memory write.
 *
 * Everything is bounded: a fixed number of recent sessions, a char budget per
 * session and overall, so the distill call can't blow the context window.
 */

/** Max past sessions folded into one consolidation pass. */
export const MAX_CONSOLIDATED_SESSIONS = 12;
/** Max chars of one session's serialized trace fed to the distiller. */
export const MAX_SESSION_TRACE_CHARS = 4_000;
/** Overall char budget across all sessions in the prompt. */
export const MAX_TOTAL_TRACE_CHARS = 24_000;

/** A minimal display session shape the consolidation reads (subset of SessionRecord). */
export type ConsolidationSession = {
  id: string;
  title: string;
  updatedAt: number;
  messages: readonly AgentMessage[];
};

/**
 * Serialize ONE session's display messages to a compact textual trace: prose text
 * verbatim, tool calls as `[ran name — summary]` one-liners (no payloads), images
 * and compaction boundaries as markers. Pure — reads only the display parts, so it
 * never touches raw tool output or secrets beyond the already-scrubbed summaries.
 * Clipped to {@link MAX_SESSION_TRACE_CHARS}.
 */
export function serializeSessionTrace(session: ConsolidationSession): string {
  const lines: string[] = [];
  for (const m of session.messages) {
    const pieces: string[] = [];
    for (const part of m.parts) {
      if (part.type === 'text' && part.text.trim()) pieces.push(part.text.trim());
      else if (part.type === 'tool') {
        const summary = part.call.summary ?? part.call.name;
        pieces.push(`[ran ${part.call.name} — ${summary}]`);
      } else if (part.type === 'image') pieces.push('[image]');
      else if (part.type === 'compaction') pieces.push('[earlier turns compacted]');
      // reasoning is display-only and intentionally omitted.
    }
    const text = pieces.join(' ').trim();
    if (text) lines.push(`${m.role}: ${text}`);
  }
  const joined = lines.join('\n');
  return joined.length > MAX_SESSION_TRACE_CHARS
    ? `${joined.slice(0, MAX_SESSION_TRACE_CHARS)}\n… (session truncated)`
    : joined;
}

/**
 * Select + bound the sessions that go into a consolidation: newest first, capped
 * at {@link MAX_CONSOLIDATED_SESSIONS}, dropping sessions whose trace is empty
 * (nothing to distill). Pure. Returns the chosen sessions paired with their
 * serialized traces.
 */
export function selectSessionsForConsolidation(
  sessions: readonly ConsolidationSession[],
): { session: ConsolidationSession; trace: string }[] {
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const out: { session: ConsolidationSession; trace: string }[] = [];
  for (const session of sorted) {
    if (out.length >= MAX_CONSOLIDATED_SESSIONS) break;
    const trace = serializeSessionTrace(session);
    if (trace.trim()) out.push({ session, trace });
  }
  return out;
}

/**
 * Build the distill prompt from selected session traces, enforcing the overall
 * char budget ({@link MAX_TOTAL_TRACE_CHARS}) by dropping the oldest sessions
 * once the budget is spent (the newest are most relevant). Pure. Returns null
 * when there is nothing to consolidate (no sessions / all empty).
 */
export function buildConsolidationPrompt(
  selected: readonly { session: ConsolidationSession; trace: string }[],
): string | null {
  const blocks: string[] = [];
  let budget = MAX_TOTAL_TRACE_CHARS;
  for (const { session, trace } of selected) {
    if (budget <= 0) break;
    const clipped = trace.length > budget ? `${trace.slice(0, budget)}\n… (truncated)` : trace;
    budget -= clipped.length;
    const title = session.title.trim() || 'Untitled chat';
    blocks.push(`<session title="${escapeAttr(title)}">\n${clipped}\n</session>`);
  }
  if (blocks.length === 0) return null;
  return `${MEMORY_CONSOLIDATION_INSTRUCTION}\n\n${blocks.join('\n\n')}`;
}

/** Escape a string for safe use inside a double-quoted XML-ish attribute. */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The consolidated note body the orchestrator writes: distilled text + a provenance footer. */
export function assembleConsolidatedNote(distilled: string, sessionCount: number, at: number): string {
  const stamp = new Date(at).toISOString().slice(0, 10);
  const footer = `\n\n---\n_Auto-consolidated from ${sessionCount} recent session${sessionCount === 1 ? '' : 's'} on ${stamp}. Safe to edit; it is overwritten on the next consolidation._`;
  return `${distilled.trim()}${footer}`;
}
