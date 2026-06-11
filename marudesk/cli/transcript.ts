import type {
  AgentChatState,
  AgentMessage,
  AgentPart,
  AgentStatus,
  ToolCall,
} from '../shared/agent';
import { bold, cyan, dim, gray, green, red, wrapText, yellow } from './ansi';
import { createMarkdownRenderer, type MarkdownRenderer } from './markdown';

/**
 * Snapshot differ for the TUI transcript (chat CLI v2 —
 * docs/chat-cli-tui-design.md §5). Each `agent:event` snapshot carries the FULL
 * chat state; this module turns the stream of snapshots into:
 *
 *  - `commit` lines — finalized scrollback, printed exactly once (completed
 *    markdown lines, settled tool results, user echoes, plan updates, turn
 *    endings). Inline TUI grammar: scrollback is append-only.
 *  - a `live` view — the in-flight tail (partial markdown line, running tools),
 *    repainted in the sticky bottom block every frame.
 *
 * A cursor (message index, part index, char offset) walks the message list in
 * order; everything behind it is committed. A non-terminal tool part halts the
 * cursor (its line stays live with a spinner) — matching how a turn actually
 * interleaves text and tool execution. Pure aside from injected `cols()`, so
 * the harness can drive it with synthetic snapshots.
 */

export type TranscriptUpdate = {
  commit: string[];
  /** True when a busy turn just settled (status fell to completed/failed). */
  settled: boolean;
};

export type LiveView = {
  lines: string[];
  /** Display names of tools currently running (also shown by the status line). */
  runningTools: string[];
};

const BUSY: ReadonlySet<AgentStatus> = new Set(['thinking', 'working', 'waiting_for_user']);

type Cursor = { msg: number; part: number; offset: number };

type ToolSeen = { state: ToolCall['state'] };

function toolGlyph(call: ToolCall): string {
  switch (call.state) {
    case 'ok':
      return green('✓');
    case 'error':
      return red('✗');
    case 'denied':
      return red('⊘');
    case 'aborted':
      return yellow('◼');
    default:
      return dim('⚙');
  }
}

function toolLabel(call: ToolCall): string {
  const summary = call.summary ? ` ${dim('—')} ${dim(call.summary)}` : '';
  const suffix =
    call.state === 'error' || call.state === 'denied' || call.state === 'aborted'
      ? ` ${red(`(${call.state})`)}`
      : '';
  return `${toolGlyph(call)} ${cyan(call.name)}${summary}${suffix}`;
}

function planLines(state: AgentChatState, cols: number): string[] {
  if (!state.plan) return [];
  const out: string[] = ['', dim('◐ plan')];
  for (const step of state.plan.steps) {
    const mark =
      step.status === 'done' ? green('✓') : step.status === 'in_progress' ? yellow('▸') : dim('○');
    for (const [i, l] of wrapText(step.title, cols - 4).entries()) {
      out.push(i === 0 ? `  ${mark} ${l}` : `    ${l}`);
    }
  }
  out.push('');
  return out;
}

function planKey(state: AgentChatState): string {
  if (!state.plan) return '';
  return state.plan.steps.map((s) => `${s.id}:${s.status}:${s.title}`).join('|');
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function createTranscript(opts: { cols(): number }) {
  let cursor: Cursor = { msg: 0, part: 0, offset: 0 };
  /** Message ids in committed order, to detect reset/resume (history swap). */
  let knownIds: string[] = [];
  const tools = new Map<string, ToolSeen>();
  /** `messageId:partIndex` keys whose "✦ thinking" header is already printed. */
  const reasoningHeaders = new Set<string>();
  let md: MarkdownRenderer = createMarkdownRenderer();
  let lastStatus: AgentStatus = 'idle';
  let lastPlanKey = '';
  let lastSnapshot: AgentChatState | null = null;

  const reset = (): void => {
    cursor = { msg: 0, part: 0, offset: 0 };
    knownIds = [];
    tools.clear();
    reasoningHeaders.clear();
    md = createMarkdownRenderer();
    lastPlanKey = '';
  };

  /** The conversation changed underneath us (reset / session resume)? */
  const historySwapped = (messages: AgentMessage[]): boolean => {
    for (let i = 0; i < knownIds.length; i++) {
      if (messages[i]?.id !== knownIds[i]) return true;
    }
    return false;
  };

  const commitUserEcho = (commit: string[], message: AgentMessage, cols: number): void => {
    const text = message.parts
      .map((p) => (p.type === 'text' ? p.text : p.type === 'image' ? '[image]' : ''))
      .join('')
      .trimEnd();
    commit.push('');
    const lines = wrapText(text, cols - 2);
    for (const [i, l] of lines.entries()) {
      commit.push(i === 0 ? `${gray('❯')} ${bold(l)}` : `  ${bold(l)}`);
    }
  };

  /**
   * Commit the completed prefix of a streaming text/reasoning part: everything
   * up to the last newline goes through the markdown renderer; the partial tail
   * stays live. Returns the new offset.
   */
  const commitTextPart = (
    commit: string[],
    part: { text: string },
    offset: number,
    cols: number,
    reasoning: boolean,
  ): number => {
    const text = part.text;
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < offset) return offset;
    const chunk = text.slice(offset, lastNl);
    for (const line of chunk.split('\n')) {
      if (reasoning) {
        for (const l of wrapText(line, cols - 2)) commit.push(dim(`  ${l}`));
      } else {
        commit.push(...md.renderLine(line, cols));
      }
    }
    return lastNl + 1;
  };

  /** Flush a finished part entirely (cursor moves past it). */
  const finishTextPart = (
    commit: string[],
    part: { text: string },
    offset: number,
    cols: number,
    reasoning: boolean,
  ): void => {
    const rest = part.text.slice(offset).replace(/\n$/, '');
    if (rest.length === 0) return;
    for (const line of rest.split('\n')) {
      if (reasoning) {
        for (const l of wrapText(line, cols - 2)) commit.push(dim(`  ${l}`));
      } else {
        commit.push(...md.renderLine(line, cols));
      }
    }
  };

  const isTerminalTool = (state: ToolCall['state']): boolean =>
    state === 'ok' || state === 'error' || state === 'denied' || state === 'aborted';

  const apply = (state: AgentChatState): TranscriptUpdate => {
    const cols = Math.max(20, opts.cols());
    const commit: string[] = [];

    if (historySwapped(state.messages)) {
      reset();
      commit.push(
        '',
        dim(state.messages.length > 0 ? '── conversation restored ──' : '── new conversation ──'),
        '',
      );
    }

    // Walk messages from the cursor, committing finished content.
    while (cursor.msg < state.messages.length) {
      const message = state.messages[cursor.msg];
      if (knownIds.length <= cursor.msg) {
        // First visit of this message.
        knownIds.push(message.id);
        if (message.role === 'user') {
          commitUserEcho(commit, message, cols);
          cursor = { msg: cursor.msg + 1, part: 0, offset: 0 };
          continue;
        }
        // A fresh assistant message starts a new markdown stream + a gap line.
        md.reset();
        commit.push('');
      }
      if (message.role === 'user') {
        // Already echoed on first visit; nothing streams into a user row.
        cursor = { msg: cursor.msg + 1, part: 0, offset: 0 };
        continue;
      }

      const parts: AgentPart[] = message.parts;
      let halted = false;
      while (cursor.part < parts.length) {
        const part = parts[cursor.part];
        const isLast = cursor.msg === state.messages.length - 1 && cursor.part === parts.length - 1;

        if (part.type === 'text' || part.type === 'reasoning') {
          const reasoning = part.type === 'reasoning';
          const headerKey = `${message.id}:${cursor.part}`;
          if (reasoning && part.text.length > 0 && !reasoningHeaders.has(headerKey)) {
            reasoningHeaders.add(headerKey);
            commit.push(dim('✦ thinking'));
          }
          cursor.offset = commitTextPart(commit, part, cursor.offset, cols, reasoning);
          if (isLast && BUSY.has(state.status)) {
            halted = true; // still streaming — partial tail stays live
            break;
          }
          finishTextPart(commit, part, cursor.offset, cols, reasoning);
          cursor = { ...cursor, part: cursor.part + 1, offset: 0 };
          continue;
        }

        if (part.type === 'tool') {
          const seen = tools.get(part.call.id);
          if (!seen) tools.set(part.call.id, { state: part.call.state });
          else seen.state = part.call.state;
          if (!isTerminalTool(part.call.state)) {
            halted = true; // running/awaiting tool — its line stays live
            break;
          }
          commit.push(`  ${toolLabel(part.call)}`);
          if (part.call.media) {
            for (const m of part.call.media) commit.push(dim(`    ↳ ${m.kind}: ${m.path}`));
          }
          cursor = { ...cursor, part: cursor.part + 1, offset: 0 };
          continue;
        }

        if (part.type === 'compaction') {
          commit.push('', dim(`── compacted earlier turns${part.freedTokens ? ` (freed ~${formatTokens(part.freedTokens)} tok)` : ''} ──`), '');
          cursor = { ...cursor, part: cursor.part + 1, offset: 0 };
          continue;
        }

        // image parts in assistant rows are rare; note and move on.
        commit.push(dim('  [image]'));
        cursor = { ...cursor, part: cursor.part + 1, offset: 0 };
      }

      if (halted) break;
      if (cursor.part >= parts.length) {
        const lastMessage = cursor.msg === state.messages.length - 1;
        if (lastMessage && BUSY.has(state.status)) break; // more parts may stream in
        cursor = { msg: cursor.msg + 1, part: 0, offset: 0 };
      }
    }

    // Plan updates (Taskboard) — commit when the step set/statuses change.
    const pk = planKey(state);
    if (pk !== lastPlanKey) {
      lastPlanKey = pk;
      if (state.plan) commit.push(...planLines(state, cols));
    }

    // Turn settle: ✔ done / ✗ error line + usage.
    const settled =
      BUSY.has(lastStatus) && (state.status === 'completed' || state.status === 'failed');
    lastStatus = state.status;
    if (settled) {
      commit.push('');
      if (state.status === 'failed') {
        for (const l of wrapText(state.error ?? 'turn failed', cols - 2)) {
          commit.push(red(`✗ ${l}`));
        }
      } else {
        const note = state.endNote ? dim(` (${state.endNote})`) : '';
        const u = state.usage;
        commit.push(
          green('✔ done') +
            note +
            dim(
              ` · ↑${formatTokens(u.inputTokens)} ↓${formatTokens(u.outputTokens)} tok`,
            ),
        );
      }
    }

    lastSnapshot = state;
    return { commit, settled };
  };

  const live = (spinner: string): LiveView => {
    const state = lastSnapshot;
    if (!state) return { lines: [], runningTools: [] };
    const cols = Math.max(20, opts.cols());
    const lines: string[] = [];
    const runningTools: string[] = [];

    const message = state.messages[cursor.msg];
    if (message && message.role === 'assistant') {
      const parts = message.parts;
      const part = parts[cursor.part];
      if (part && (part.type === 'text' || part.type === 'reasoning')) {
        const tail = part.text.slice(cursor.offset);
        if (tail.length > 0) {
          if (part.type === 'reasoning') {
            for (const l of wrapText(tail, cols - 2)) lines.push(dim(`  ${l}`));
          } else {
            lines.push(...md.previewLine(tail, cols));
          }
        }
      }
      // Every non-terminal tool from the cursor on stays live with a spinner.
      for (let i = cursor.part; i < parts.length; i++) {
        const p = parts[i];
        if (p.type !== 'tool') continue;
        if (isTerminalTool(p.call.state)) continue;
        runningTools.push(p.call.name);
        const label =
          p.call.state === 'awaiting_approval'
            ? `${yellow('⏸')} ${cyan(p.call.name)} ${dim('— waiting for approval')}`
            : `${cyan(spinner)} ${cyan(p.call.name)}${p.call.summary ? ` ${dim('—')} ${dim(p.call.summary)}` : ''}`;
        lines.push(`  ${label}`);
        if (p.call.streamedText) {
          const tail = p.call.streamedText.slice(-200).split('\n').slice(-2);
          for (const t of tail) for (const l of wrapText(t, cols - 4)) lines.push(dim(`    ${l}`));
        }
      }
    }
    return { lines, runningTools };
  };

  return { apply, live, reset };
}
