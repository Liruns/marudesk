import { create } from 'zustand';
import type { AgentEdit } from '../../../../shared/agent';
import type { useI18n } from '../../../i18n/useI18n';
import { toDiffLines } from '../diff';

/**
 * Renderer-only store for inline diff review comments (v6 §U1). Keyed by edit id →
 * (diff line index → comment text). Deliberately NOT part of the server-owned
 * {@link AgentChatState}: these are transient review notes the user composes on
 * the applied-changes diff, then sends to the agent as one feedback turn (after
 * which they clear). The line index is stable per edit because {@link toDiffLines}
 * is deterministic from the edit's frozen before/after.
 */
type CommentsByEdit = Record<string, Record<number, string>>;

type DiffCommentsState = {
  byEdit: CommentsByEdit;
  /** Add/update (text) or remove (null/blank) the comment on an edit's line. */
  setComment: (editId: string, lineIndex: number, text: string | null) => void;
  /** Drop all comments (after sending, or on chat reset/resume). */
  clearAll: () => void;
};

export const useDiffCommentsStore = create<DiffCommentsState>((set) => ({
  byEdit: {},
  setComment: (editId, lineIndex, text) =>
    set((s) => {
      const trimmed = text?.trim();
      const cur = { ...(s.byEdit[editId] ?? {}) };
      if (trimmed) cur[lineIndex] = trimmed;
      else delete cur[lineIndex];
      const next = { ...s.byEdit };
      if (Object.keys(cur).length > 0) next[editId] = cur;
      else delete next[editId];
      return { byEdit: next };
    }),
  clearAll: () => set({ byEdit: {} }),
}));

/** Total number of comments across all edits — drives the "Send N comments" button. */
export function countDiffComments(byEdit: CommentsByEdit): number {
  return Object.values(byEdit).reduce((acc, m) => acc + Object.keys(m).length, 0);
}

/**
 * Compose the user's inline comments into one feedback prompt the agent can act on.
 * Each comment is rendered with its file:line location, the diff line it targets
 * (with +/−/ context sign), and the note — so the model knows exactly where to look.
 * Edits/lines that no longer resolve (e.g. after a session resume) are skipped.
 */
export function composeDiffCommentsPrompt(
  edits: readonly AgentEdit[],
  byEdit: CommentsByEdit,
  t: ReturnType<typeof useI18n>['t'],
): string {
  const blocks: string[] = [];
  for (const edit of edits) {
    const map = byEdit[edit.id];
    if (!map) continue;
    const lines = toDiffLines(edit.before, edit.after);
    const entries = Object.entries(map)
      .map(([idx, note]) => ({ line: lines[Number(idx)], note }))
      .filter((e): e is { line: NonNullable<(typeof lines)[number]>; note: string } => !!e.line);
    if (entries.length === 0) continue;
    const rows = entries.map(({ line, note }) => {
      const lineNo = line.newLineNumber ?? line.oldLineNumber;
      const loc = lineNo ? `${edit.path}:${lineNo}` : edit.path;
      const sign = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
      return `- ${loc}  \`${sign}${line.content}\`\n  → ${note}`;
    });
    blocks.push(rows.join('\n'));
  }
  return `${t('agent.chat.comments.promptHeader')}\n\n${blocks.join('\n\n')}`;
}
