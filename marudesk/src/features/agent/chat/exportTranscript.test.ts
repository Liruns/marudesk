import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '../../../../shared/agent';
import { transcriptToMarkdown } from './exportTranscript';

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
