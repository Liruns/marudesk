import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '../../../../shared/agent';
import { transcriptToHtml, transcriptToMarkdown } from './exportTranscript';

const msg = (partial: Partial<AgentMessage> & Pick<AgentMessage, 'id' | 'role' | 'parts'>): AgentMessage => ({
  timestamp: 0,
  ...partial,
});

describe('transcriptToMarkdown', () => {
  it('serializes roles, text, tool calls, and compaction dividers', () => {
    const md = transcriptToMarkdown([
      msg({ id: '1', role: 'user', parts: [{ type: 'text', text: 'fix the bug' }] }),
      msg({
        id: '2',
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'private thoughts' },
          { type: 'tool', call: { id: 't1', name: 'read_file', state: 'ok', summary: 'src/app.ts', input: {} } },
          { type: 'text', text: 'Done — patched it.' },
        ],
      }),
      msg({ id: '3', role: 'assistant', parts: [{ type: 'compaction', summary: 's' }] }),
    ]);
    expect(md).toContain('## You\n\nfix the bug');
    expect(md).toContain('> 🔧 `read_file` — src/app.ts');
    expect(md).toContain('## Assistant\n\n');
    expect(md).toContain('Done — patched it.');
    expect(md).toContain('_Earlier turns were compacted into a summary._');
    expect(md).not.toContain('private thoughts');
  });

  it('skips empty messages', () => {
    const md = transcriptToMarkdown([msg({ id: '1', role: 'assistant', parts: [{ type: 'text', text: '  ' }] })]);
    expect(md.trim()).toBe('');
  });
});

describe('transcriptToHtml', () => {
  it('renders a self-contained document with inline styles and no scripts', () => {
    const html = transcriptToHtml(
      [
        msg({ id: '1', role: 'user', parts: [{ type: 'text', text: 'fix the bug' }] }),
        msg({
          id: '2',
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: 'private thoughts' },
            {
              type: 'tool',
              call: {
                id: 't1',
                name: 'read_file',
                state: 'ok',
                summary: 'src/app.ts',
                input: {},
                resultText: 'line one\nline two',
              },
            },
            { type: 'text', text: 'Done — patched it.' },
          ],
        }),
      ],
      { title: 'My session', generatedAt: 0 },
    );
    // Self-contained: a full document, inline <style>, and no external/script refs.
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('src=');
    expect(html).not.toContain('http://');
    // Turns are role-distinguished and the title shows.
    expect(html).toContain('class="turn user"');
    expect(html).toContain('class="turn assistant"');
    expect(html).toContain('My session');
    // Tool call keeps its name, summary, and (escaped) result text in a card.
    expect(html).toContain('read_file');
    expect(html).toContain('src/app.ts');
    expect(html).toContain('line one');
    expect(html).toContain('Done — patched it.');
    // Reasoning is omitted, exactly as in the markdown export.
    expect(html).not.toContain('private thoughts');
  });

  it('escapes hostile markup in text and tool output', () => {
    const html = transcriptToHtml([
      msg({ id: '1', role: 'user', parts: [{ type: 'text', text: '<script>alert(1)</script>' }] }),
      msg({
        id: '2',
        role: 'assistant',
        parts: [
          {
            type: 'tool',
            call: { id: 't', name: 'grep', state: 'ok', summary: '<img onerror=x>', input: {} },
          },
        ],
      }),
    ]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img onerror=x&gt;');
  });

  it('renders a compaction divider and skips empty turns', () => {
    const html = transcriptToHtml([
      msg({ id: '1', role: 'assistant', parts: [{ type: 'compaction', summary: 's' }] }),
      msg({ id: '2', role: 'assistant', parts: [{ type: 'text', text: '   ' }] }),
    ]);
    expect(html).toContain('class="divider"');
    expect(html).toContain('compacted');
    // The empty (whitespace-only) turn produced no <section>.
    expect(html).not.toContain('class="turn assistant"');
  });
});
