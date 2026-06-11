/**
 * The composer's line-editor state machine (chat CLI v2 —
 * docs/chat-cli-tui-design.md §5): text + cursor + prompt history as pure data
 * with pure transitions, so editing behavior is harness-testable without a TTY.
 * The cursor is an index in UTF-16 code units but every movement lands on a
 * code-point boundary (never inside a surrogate pair).
 */

export type ComposerState = {
  text: string;
  /** Cursor position in code units, always on a code-point boundary. */
  cursor: number;
};

export const EMPTY_COMPOSER: ComposerState = { text: '', cursor: 0 };

/** Step left from `i` to the previous code-point boundary. */
function prevBoundary(text: string, i: number): number {
  if (i <= 0) return 0;
  let j = i - 1;
  const code = text.charCodeAt(j);
  if (code >= 0xdc00 && code <= 0xdfff && j > 0) j--; // low surrogate → include high
  return j;
}

/** Step right from `i` to the next code-point boundary. */
function nextBoundary(text: string, i: number): number {
  if (i >= text.length) return text.length;
  const code = text.charCodeAt(i);
  return i + (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length ? 2 : 1);
}

export function insert(s: ComposerState, input: string): ComposerState {
  return {
    text: s.text.slice(0, s.cursor) + input + s.text.slice(s.cursor),
    cursor: s.cursor + input.length,
  };
}

export function backspace(s: ComposerState): ComposerState {
  if (s.cursor === 0) return s;
  const at = prevBoundary(s.text, s.cursor);
  return { text: s.text.slice(0, at) + s.text.slice(s.cursor), cursor: at };
}

export function del(s: ComposerState): ComposerState {
  if (s.cursor >= s.text.length) return s;
  return {
    text: s.text.slice(0, s.cursor) + s.text.slice(nextBoundary(s.text, s.cursor)),
    cursor: s.cursor,
  };
}

export function moveLeft(s: ComposerState): ComposerState {
  return { ...s, cursor: prevBoundary(s.text, s.cursor) };
}

export function moveRight(s: ComposerState): ComposerState {
  return { ...s, cursor: nextBoundary(s.text, s.cursor) };
}

export function moveHome(s: ComposerState): ComposerState {
  return { ...s, cursor: 0 };
}

export function moveEnd(s: ComposerState): ComposerState {
  return { ...s, cursor: s.text.length };
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Start of the word at/left of the cursor (readline backward-word). */
function wordLeftIndex(text: string, from: number): number {
  let i = from;
  while (i > 0 && !WORD_CHAR.test(text[prevBoundary(text, i)])) i = prevBoundary(text, i);
  while (i > 0 && WORD_CHAR.test(text[prevBoundary(text, i)])) i = prevBoundary(text, i);
  return i;
}

/** End of the word at/right of the cursor (readline forward-word). */
function wordRightIndex(text: string, from: number): number {
  let i = from;
  while (i < text.length && !WORD_CHAR.test(text[i])) i = nextBoundary(text, i);
  while (i < text.length && WORD_CHAR.test(text[i])) i = nextBoundary(text, i);
  return i;
}

export function moveWordLeft(s: ComposerState): ComposerState {
  return { ...s, cursor: wordLeftIndex(s.text, s.cursor) };
}

export function moveWordRight(s: ComposerState): ComposerState {
  return { ...s, cursor: wordRightIndex(s.text, s.cursor) };
}

/** Ctrl+W: delete the word left of the cursor. */
export function deleteWordLeft(s: ComposerState): ComposerState {
  const at = wordLeftIndex(s.text, s.cursor);
  return { text: s.text.slice(0, at) + s.text.slice(s.cursor), cursor: at };
}

/** Ctrl+K: kill from the cursor to the end. */
export function killToEnd(s: ComposerState): ComposerState {
  return { text: s.text.slice(0, s.cursor), cursor: s.cursor };
}

/** Ctrl+U: kill from the start to the cursor. */
export function killToStart(s: ComposerState): ComposerState {
  return { text: s.text.slice(s.cursor), cursor: 0 };
}

/* ── prompt history (↑/↓ on an empty/browsing composer) ───────────────────── */

export type HistoryState = {
  entries: string[];
  /** entries.length = not browsing; otherwise the index being viewed. */
  index: number;
  /** The in-progress draft saved when browsing began. */
  draft: string;
};

export function emptyHistory(): HistoryState {
  return { entries: [], index: 0, draft: '' };
}

const HISTORY_MAX = 200;

/** Record a sent prompt (dedupes an immediate repeat) and stop browsing. */
export function pushHistory(h: HistoryState, entry: string): HistoryState {
  const entries =
    entry.trim().length === 0 || h.entries[h.entries.length - 1] === entry
      ? h.entries
      : [...h.entries, entry].slice(-HISTORY_MAX);
  return { entries, index: entries.length, draft: '' };
}

/** ↑: step back through history (saving the live draft on first step). */
export function historyPrev(
  h: HistoryState,
  current: string,
): { history: HistoryState; text: string } | null {
  if (h.entries.length === 0 || h.index === 0) return null;
  const browsing = h.index < h.entries.length;
  const index = h.index - 1;
  return {
    history: { ...h, index, draft: browsing ? h.draft : current },
    text: h.entries[index],
  };
}

/** ↓: step forward; landing past the newest restores the saved draft. */
export function historyNext(h: HistoryState): { history: HistoryState; text: string } | null {
  if (h.index >= h.entries.length) return null;
  const index = h.index + 1;
  if (index === h.entries.length) {
    return { history: { ...h, index }, text: h.draft };
  }
  return { history: { ...h, index }, text: h.entries[index] };
}
