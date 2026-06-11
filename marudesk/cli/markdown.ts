import { bold, cyan, dim, gray, italic, underline, wrapText } from './ansi';

/**
 * Markdown-lite → ANSI for streamed chat text (chat CLI v2 —
 * docs/chat-cli-tui-design.md §5). Line-oriented so it can style a stream
 * incrementally: the transcript feeds each COMPLETED line through
 * {@link MarkdownRenderer.renderLine} (fence state persists across lines) and
 * previews the in-flight partial line without mutating that state.
 *
 * Deliberately not a full parser: headings, fences, lists, quotes, rules, and
 * inline code/bold/italic/links. Unmatched inline markers stay literal text —
 * the well-behaved degradation for wrapped or still-streaming spans.
 */

/** Style inline spans (`code`, **bold**, *italic*, [text](url)) — complete pairs only. */
export function styleInline(text: string): string {
  let out = text;
  // `code` first so markers inside code spans aren't bold/italic-processed.
  out = out.replace(/`([^`\n]+)`/g, (_, c: string) => cyan(c));
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_, b: string) => bold(b));
  out = out.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, (_, i: string) => italic(i));
  out = out.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, (_, i: string) => italic(i));
  out = out.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
    (_, label: string, url: string) => `${underline(label)} ${dim(`(${url})`)}`,
  );
  return out;
}

export type MarkdownRenderer = {
  /** Style + wrap one completed line; advances fence state. */
  renderLine(line: string, cols: number): string[];
  /** Style + wrap an in-flight partial line; fence state untouched. */
  previewLine(line: string, cols: number): string[];
  reset(): void;
};

export function createMarkdownRenderer(): MarkdownRenderer {
  let inFence = false;

  const render = (line: string, cols: number, commit: boolean): string[] => {
    const fenceMark = /^\s*(```|~~~)/.test(line);
    if (fenceMark) {
      if (commit) inFence = !inFence;
      return [dim(line)];
    }
    if (inFence) {
      // Code lines verbatim (no inline styling), indented + tinted.
      return wrapText(line, cols - 2).map((l) => `  ${cyan(l)}`);
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const text = styleInline(heading[2]);
      const styled = heading[1].length === 1 ? bold(underline(text)) : bold(text);
      return wrapText(heading[2], cols).map((_, i, arr) =>
        // Headings rarely wrap; restyle the whole heading on its first line and
        // plain-bold any overflow so pairs never split mid-style.
        i === 0 && arr.length === 1 ? styled : bold(arr[i]),
      );
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      return wrapText(quote[1], cols - 2).map((l) => dim(`│ ${l}`));
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      return [dim('─'.repeat(Math.max(4, Math.min(cols, 40))))];
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      const indent = bullet[1];
      const lines = wrapText(bullet[2], cols - indent.length - 2);
      return lines.map((l, i) =>
        i === 0 ? `${indent}${gray('•')} ${styleInline(l)}` : `${indent}  ${styleInline(l)}`,
      );
    }

    const ordered = /^(\s*)(\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (ordered) {
      const indent = ordered[1];
      const marker = ordered[2];
      const lines = wrapText(ordered[3], cols - indent.length - marker.length - 1);
      return lines.map((l, i) =>
        i === 0
          ? `${indent}${gray(marker)} ${styleInline(l)}`
          : `${indent}${' '.repeat(marker.length)} ${styleInline(l)}`,
      );
    }

    return wrapText(line, cols).map((l) => styleInline(l));
  };

  return {
    renderLine: (line, cols) => render(line, Math.max(8, cols), true),
    previewLine: (line, cols) => render(line, Math.max(8, cols), false),
    reset: () => {
      inFence = false;
    },
  };
}
