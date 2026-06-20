import type { AgentMessage, ToolCall } from '../../../../shared/agent';

/**
 * Serialize the visible transcript to a portable markdown document. Display-only
 * parts keep a faithful trace without dumping raw payloads: tool calls become
 * one-line quotes, images become placeholders, reasoning is omitted (it is
 * display-only and never part of the conversation record), and compaction
 * boundaries become dividers.
 */
export function transcriptToMarkdown(messages: readonly AgentMessage[]): string {
  const blocks: string[] = [];
  for (const m of messages) {
    const compaction = m.parts.find((p) => p.type === 'compaction');
    if (compaction) {
      blocks.push('---', '> _Earlier turns were compacted into a summary._');
      continue;
    }
    const body: string[] = [];
    for (const part of m.parts) {
      if (part.type === 'text' && part.text.trim()) {
        body.push(part.text.trim());
      } else if (part.type === 'tool') {
        const summary = part.call.summary ?? part.call.name;
        body.push(`> 🔧 \`${part.call.name}\` — ${summary}`);
        for (const media of part.call.media ?? []) {
          body.push(`> 🖼️ \`${media.path}\``);
        }
      } else if (part.type === 'image') {
        body.push('> 🖼️ _(attached image)_');
      }
    }
    if (body.length === 0) continue;
    blocks.push(m.role === 'user' ? '## You' : '## Assistant', ...body);
  }
  return `${blocks.join('\n\n')}\n`;
}

/** Trigger a download of the transcript as a dated `.md` file. */
export function downloadTranscript(messages: readonly AgentMessage[]): void {
  download(transcriptToMarkdown(messages), 'md', 'text/markdown;charset=utf-8');
}

/* ── self-contained HTML export (SECOND-PASS: gajae export/html/*) ─────────── */

/** Escape a string for safe interpolation into HTML text/attribute content. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A tool call rendered as a `<details>` card: header summary + expandable result. */
function toolCallHtml(call: ToolCall): string {
  const summary = escapeHtml(call.summary ?? call.name);
  const stateClass = call.state === 'error' ? ' tool--error' : '';
  const result = call.resultText?.trim()
    ? `<pre class="tool-result">${escapeHtml(call.resultText.trim())}</pre>`
    : '';
  const error = call.error?.trim() ? `<pre class="tool-error">${escapeHtml(call.error.trim())}</pre>` : '';
  const media = (call.media ?? [])
    .map((m) => `<div class="tool-media">🖼️ <code>${escapeHtml(m.path)}</code></div>`)
    .join('');
  return (
    `<details class="tool${stateClass}">` +
    `<summary><span class="tool-name">${escapeHtml(call.name)}</span>` +
    `<span class="tool-summary">${summary}</span></summary>` +
    `${error}${result}${media}` +
    `</details>`
  );
}

/** Render a single message's body parts to HTML (text → paragraphs, tools → cards). */
function messageBodyHtml(message: AgentMessage): string {
  const blocks: string[] = [];
  for (const part of message.parts) {
    if (part.type === 'text' && part.text.trim()) {
      blocks.push(`<p class="text">${escapeHtml(part.text.trim()).replace(/\n/g, '<br>')}</p>`);
    } else if (part.type === 'tool') {
      blocks.push(toolCallHtml(part.call));
    } else if (part.type === 'image') {
      blocks.push('<div class="image-ph">🖼️ <em>(attached image)</em></div>');
    }
    // reasoning is display-only and intentionally omitted, matching markdown export.
  }
  return blocks.join('\n');
}

const HTML_STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--muted:#6b7280;--border:#e5e7eb;--user-bg:#eef2ff;--assistant-bg:#f8fafc;--tool-bg:#f1f5f9;--tool-border:#cbd5e1;--error:#dc2626;--code:#0f172a;--code-bg:#f1f5f9;}
@media(prefers-color-scheme:dark){:root{--bg:#0f1117;--fg:#e5e7eb;--muted:#9ca3af;--border:#2a2f3a;--user-bg:#1e253b;--assistant-bg:#161a23;--tool-bg:#1a1f2b;--tool-border:#3a4150;--error:#f87171;--code:#e5e7eb;--code-bg:#1a1f2b;}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
.wrap{max-width:820px;margin:0 auto;padding:32px 20px 64px;}
h1{font-size:18px;margin:0 0 4px;}
.meta{color:var(--muted);font-size:13px;margin:0 0 28px;}
.turn{border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin:0 0 14px;}
.turn.user{background:var(--user-bg);}
.turn.assistant{background:var(--assistant-bg);}
.role{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:0 0 8px;}
.text{margin:0 0 10px;white-space:normal;word-wrap:break-word;}
.text:last-child{margin-bottom:0;}
.tool{border:1px solid var(--tool-border);background:var(--tool-bg);border-radius:8px;margin:8px 0;overflow:hidden;}
.tool.tool--error{border-color:var(--error);}
.tool>summary{cursor:pointer;padding:8px 12px;list-style:none;display:flex;gap:8px;align-items:baseline;font-size:13px;}
.tool>summary::-webkit-details-marker{display:none;}
.tool-name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--muted);}
.tool-summary{color:var(--fg);}
.tool-result,.tool-error{margin:0;padding:10px 12px;border-top:1px solid var(--tool-border);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;color:var(--code);background:var(--code-bg);overflow-x:auto;}
.tool-error{color:var(--error);}
.tool-media{padding:8px 12px;border-top:1px solid var(--tool-border);font-size:12px;}
.image-ph{color:var(--muted);font-size:13px;margin:8px 0;}
.divider{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:12px;margin:18px 0;}
.divider::before,.divider::after{content:"";flex:1;height:1px;background:var(--border);}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em;background:var(--code-bg);padding:1px 4px;border-radius:4px;}
`;

/**
 * Serialize the visible transcript to a single self-contained HTML document
 * (inline CSS, no scripts, no network) — a richer, shareable alternative to the
 * flat markdown export (SECOND-PASS: gajae `export/html/*`). Unlike markdown, a
 * tool call keeps its (scrubbed) result text in an expandable card and the
 * user/assistant turns are visually distinguished + themed (light/dark via the
 * reader's `prefers-color-scheme`). Reasoning is omitted, exactly as in markdown:
 * it is display-only and never part of the conversation record. All transcript
 * text is HTML-escaped, so a hostile file path or tool output can't inject markup.
 */
export function transcriptToHtml(
  messages: readonly AgentMessage[],
  opts: { title?: string; generatedAt?: number } = {},
): string {
  const title = opts.title?.trim() || 'Maru chat export';
  const date = new Date(opts.generatedAt ?? Date.now());
  const turns: string[] = [];
  for (const m of messages) {
    if (m.parts.some((p) => p.type === 'compaction')) {
      turns.push('<div class="divider">Earlier turns were compacted into a summary</div>');
      continue;
    }
    const body = messageBodyHtml(m);
    if (!body.trim()) continue;
    const role = m.role === 'user' ? 'You' : 'Assistant';
    turns.push(`<section class="turn ${m.role}"><div class="role">${role}</div>${body}</section>`);
  }
  const generated = escapeHtml(date.toISOString().replace('T', ' ').slice(0, 16));
  return (
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">\n` +
    `<title>${escapeHtml(title)}</title>\n<style>${HTML_STYLE}</style>\n</head>\n` +
    `<body>\n<div class="wrap">\n<h1>${escapeHtml(title)}</h1>\n` +
    `<p class="meta">Exported ${generated} · ${turns.length} turn${turns.length === 1 ? '' : 's'}</p>\n` +
    `${turns.join('\n')}\n</div>\n</body>\n</html>\n`
  );
}

/** Trigger a download of the transcript as a dated self-contained `.html` file. */
export function downloadTranscriptHtml(messages: readonly AgentMessage[], title?: string): void {
  download(transcriptToHtml(messages, { title }), 'html', 'text/html;charset=utf-8');
}

/** Shared download helper — blob → temporary anchor → click → revoke. */
function download(content: string, ext: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `chat-${new Date().toISOString().slice(0, 10)}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
