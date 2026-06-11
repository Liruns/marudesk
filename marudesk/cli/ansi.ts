/**
 * Minimal ANSI styling + width helpers for the chat TUI (cli/ — chat CLI v2,
 * docs/chat-cli-tui-design.md §5). Zero dependencies; pure functions only so
 * the harness can exercise wrapping/width logic headlessly.
 */

export const ESC = '\x1b';
export const CSI = `${ESC}[`;

const wrap = (open: number | string, close: number | string) => (s: string) =>
  `${CSI}${open}m${s}${CSI}${close}m`;

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const italic = wrap(3, 23);
export const underline = wrap(4, 24);
export const inverse = wrap(7, 27);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const magenta = wrap(35, 39);
export const cyan = wrap(36, 39);
export const gray = wrap(90, 39);

/** Cursor/erase primitives used by the sticky-block repaint. */
export const cursorUp = (n: number): string => (n > 0 ? `${CSI}${n}A` : '');
export const eraseDown = `${CSI}0J`;
export const eraseLine = `${CSI}2K`;
export const carriageReturn = '\r';
export const showCursor = `${CSI}?25h`;
export const hideCursor = `${CSI}?25l`;
export const enableBracketedPaste = `${CSI}?2004h`;
export const disableBracketedPaste = `${CSI}?2004l`;

// CSI (colors/cursor) + OSC (titles) escapes — same shape electron/terminal.ts
// strips for the agent's read_terminal.
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/**
 * Approximate terminal cell width of one code point: 2 for East-Asian wide
 * ranges (Hangul/CJK/fullwidth/emoji), 0 for combining marks and zero-width
 * joiners, else 1. A pragmatic wcwidth — enough for wrapping Korean/CJK chat
 * text without a Unicode table dependency.
 */
export function charWidth(cp: number): number {
  // Zero-width: combining diacritics, ZWJ/ZWNJ, variation selectors.
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d ||
    (cp >= 0xfe00 && cp <= 0xfe0f)
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana..CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji blocks
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK ext B+
  ) {
    return 2;
  }
  return 1;
}

/** Display width of a string (ANSI stripped, wide chars counted as 2 cells). */
export function stringWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/**
 * Hard-wrap plain (non-ANSI) text to `cols` cells, breaking on spaces where
 * possible and mid-word otherwise (CJK has no spaces to break on). Never
 * returns an empty array — '' wraps to [''].
 */
export function wrapText(text: string, cols: number): string[] {
  const max = Math.max(1, cols);
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    let line = '';
    let width = 0;
    let lastBreak = -1; // index in `line` after the last space
    for (const ch of raw) {
      const w = charWidth(ch.codePointAt(0) ?? 0);
      if (width + w > max) {
        if (lastBreak > 0 && ch !== ' ') {
          // Break at the last space; carry the tail onto the next line.
          out.push(line.slice(0, lastBreak - 1));
          line = line.slice(lastBreak);
          width = stringWidth(line);
          lastBreak = -1;
        } else {
          out.push(line);
          line = '';
          width = 0;
          lastBreak = -1;
        }
        if (ch === ' ' && line === '') continue; // don't lead a wrapped line with the break space
      }
      line += ch;
      width += w;
      if (ch === ' ') lastBreak = line.length;
    }
    out.push(line);
  }
  return out.length > 0 ? out : [''];
}

/**
 * Truncate to at most `cols` display cells, appending `…` when cut.
 * ANSI-aware: escape sequences pass through zero-width, and a cut styled
 * string gets a full reset appended so styles can't bleed past it.
 */
export function truncate(text: string, cols: number): string {
  if (stringWidth(text) <= cols) return text;
  let out = '';
  let width = 0;
  let i = 0;
  const limit = Math.max(1, cols - 1);
  while (i < text.length) {
    ANSI_RE.lastIndex = i;
    const m = ANSI_RE.exec(text);
    if (m && m.index === i) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const cp = text.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const w = charWidth(cp);
    if (width + w > limit) break;
    out += ch;
    width += w;
    i += ch.length;
  }
  return `${out}${CSI}0m…`;
}
