import type { AgentMessage } from '../../../../shared/agent';

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
  const blob = new Blob([transcriptToMarkdown(messages)], {
    type: 'text/markdown;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `chat-${new Date().toISOString().slice(0, 10)}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
