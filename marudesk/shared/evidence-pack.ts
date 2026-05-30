import type { Capture } from './capture';
import { scrubText } from './scrub';

/**
 * Format a capture as a portable Markdown "evidence pack" (roadmap P1.5) — the
 * low-entry-barrier companion export: paste it into Cursor, a GitHub issue, or a
 * chat with any agent. Pure + scrubbed: exported evidence may land in a *public*
 * issue, so every page-originated string goes through shared/scrub.ts first.
 */

const MAX_FRAMES = 12;
const MAX_TEXT = 240;
const MAX_HTML = 2_000;

/** `{url, lineNumber}` (0-based CDP line) → `url:1-based-line`. */
function loc(source: { url: string; lineNumber?: number }): string {
  const url = scrubText(source.url);
  return source.lineNumber !== undefined ? `${url}:${source.lineNumber + 1}` : url;
}

export function formatEvidencePack(capture: Capture): string {
  const lines: string[] = [];

  if (capture.kind === 'console-error') {
    lines.push('## Console error (marudesk evidence pack)', '');
    lines.push(`- **Message:** \`${scrubText(capture.message)}\``);
    lines.push(`- **Page:** ${scrubText(capture.url)}`);
    if (capture.source) lines.push(`- **Location:** ${loc(capture.source)}`);
    if (capture.stack.length > 0) {
      lines.push('', '**Stack (innermost first):**', '```');
      for (const f of capture.stack.slice(0, MAX_FRAMES)) {
        lines.push(`  at ${f.functionName || '(anonymous)'} ${scrubText(f.url)}:${f.lineNumber + 1}:${f.columnNumber + 1}`);
      }
      lines.push('```');
    }
  } else {
    lines.push('## Element (marudesk evidence pack)', '');
    lines.push(`- **Tag:** \`<${capture.tagName.toLowerCase()}>\``);
    lines.push(`- **Selector:** \`${capture.selector || '(none)'}\``);
    lines.push(`- **Page:** ${scrubText(capture.url)}`);
    if (capture.text) lines.push(`- **Text:** ${scrubText(capture.text).slice(0, MAX_TEXT)}`);
    const attrs = Object.entries(capture.attributes);
    if (attrs.length > 0) {
      lines.push('', '**Attributes:**');
      for (const [k, v] of attrs.slice(0, MAX_FRAMES)) lines.push(`- \`${k}\` = \`${scrubText(v)}\``);
    }
    if (capture.outerHTML) {
      lines.push('', '**outerHTML:**', '```html', scrubText(capture.outerHTML).slice(0, MAX_HTML), '```');
    }
  }

  return lines.join('\n');
}
