import type { ModelMessage } from 'ai';

/**
 * Pure transcript helpers for `/compact` (claude-code / codex parity), split out
 * of loop.ts so the stateful compaction flow there reads as orchestration. None
 * of these touch module state — they map a `ModelMessage[]` to text, a char
 * weight, or a head/tail split.
 */

/**
 * Per-tool-result excerpt budget for the summarization prompt. The compaction
 * instruction asks the model to keep "error signatures verbatim" — it can only
 * do that if the serialized trace actually carries a slice of each result, not
 * just the tool's name. Small enough that a long tool-heavy head stays bounded.
 */
const TOOL_RESULT_EXCERPT_CHARS = 300;

/** A clipped, whitespace-collapsed slice of one tool result's textual output. */
function toolResultExcerpt(output: unknown): string {
  if (!output || typeof output !== 'object') return '';
  const o = output as { type?: unknown; value?: unknown };
  let text = '';
  if (typeof o.value === 'string') {
    text = o.value;
  } else if (Array.isArray(o.value)) {
    // Multipart ('content') output: keep the text items, skip inline images.
    text = o.value
      .map((item) =>
        item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
          ? (item as { text: string }).text
          : '',
      )
      .filter(Boolean)
      .join(' ');
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const clipped =
    text.length <= TOOL_RESULT_EXCERPT_CHARS ? text : `${text.slice(0, TOOL_RESULT_EXCERPT_CHARS)}…`;
  return o.type === 'error-text' ? `ERROR: ${clipped}` : clipped;
}

/** Flatten the running transcript to plain text for the summarization prompt. */
export function serializeForCompaction(msgs: ModelMessage[]): string {
  const lines: string[] = [];
  for (const m of msgs) {
    let text: string;
    if (typeof m.content === 'string') {
      text = m.content;
    } else {
      // Each part is one of the AI SDK content shapes; we only need a textual
      // trace (prose + which tools ran and what they returned), so read just
      // these fields structurally.
      const parts = m.content as ReadonlyArray<{
        type: string;
        text?: string;
        toolName?: string;
        output?: unknown;
      }>;
      const pieces: string[] = [];
      for (const p of parts) {
        if (p.type === 'text' && p.text) pieces.push(p.text);
        else if (p.type === 'tool-call' && p.toolName) pieces.push(`[ran ${p.toolName}]`);
        else if (p.type === 'tool-result' && p.toolName) {
          const excerpt = toolResultExcerpt(p.output);
          pieces.push(excerpt ? `[result of ${p.toolName}] ${excerpt}` : `[result of ${p.toolName}]`);
        } else if (p.type === 'image') pieces.push('[image]');
      }
      text = pieces.join(' ');
    }
    text = text.trim();
    if (text) lines.push(`${m.role}: ${text}`);
  }
  return lines.join('\n\n');
}

/** Rough character weight of one message (proxy for token size). */
export function messageChars(m: ModelMessage): number {
  if (typeof m.content === 'string') return m.content.length;
  let n = 0;
  for (const p of m.content as ReadonlyArray<{ text?: string; output?: { value?: string }; input?: unknown }>) {
    if (typeof p.text === 'string') n += p.text.length;
    if (typeof p.output?.value === 'string') n += p.output.value.length;
    if (p.input !== undefined) n += JSON.stringify(p.input).length;
  }
  return n;
}

/**
 * Split a transcript into the older `head` (to be summarized) and a verbatim
 * `tail` of the most recent turns. The tail is the smallest set of whole turns
 * whose character weight is at least `tailFraction` of the total, snapped to a
 * `user`-message boundary so the rebuilt transcript stays valid (alternation +
 * Anthropic's first-message-is-user rule). Falls back to an empty tail when the
 * split would leave nothing to summarize.
 */
export function splitForTailPreservation(
  msgs: ModelMessage[],
  tailFraction: number,
): { head: ModelMessage[]; tail: ModelMessage[] } {
  const total = msgs.reduce((n, m) => n + messageChars(m), 0);
  const budget = total * tailFraction;
  let acc = 0;
  let splitIdx = -1;
  for (let i = msgs.length - 1; i > 0; i--) {
    acc += messageChars(msgs[i]);
    if (msgs[i].role === 'user' && acc >= budget) {
      splitIdx = i;
      break;
    }
  }
  if (splitIdx <= 0) return { head: msgs, tail: [] };
  return { head: msgs.slice(0, splitIdx), tail: msgs.slice(splitIdx) };
}
