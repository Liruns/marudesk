import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import {
  messageChars,
  serializeForCompaction,
  splitForTailPreservation,
} from './compaction-utils';

const user = (text: string): ModelMessage => ({ role: 'user', content: text });
const assistantCall = (toolName: string): ModelMessage => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: 'c1', toolName, input: {} }],
});
const toolMsg = (
  toolName: string,
  output: { type: 'text' | 'error-text'; value: string },
): ModelMessage => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: 'c1', toolName, output }],
});

describe('serializeForCompaction', () => {
  it('keeps plain string turns verbatim', () => {
    const out = serializeForCompaction([user('fix the bug'), { role: 'assistant', content: 'on it' }]);
    expect(out).toBe('user: fix the bug\n\nassistant: on it');
  });

  it('carries a clipped excerpt of each tool result, not just the tool name', () => {
    const out = serializeForCompaction([
      assistantCall('run_diagnostics'),
      toolMsg('run_diagnostics', { type: 'text', value: 'src/app.ts:12 — TS2345 mismatch' }),
    ]);
    expect(out).toContain('[ran run_diagnostics]');
    expect(out).toContain('[result of run_diagnostics] src/app.ts:12 — TS2345 mismatch');
  });

  it('tags error results so error signatures survive into the summary', () => {
    const out = serializeForCompaction([
      toolMsg('run_command', { type: 'error-text', value: 'Error: ENOENT no such file' }),
    ]);
    expect(out).toContain('[result of run_command] ERROR: Error: ENOENT no such file');
  });

  it('bounds a huge tool result to the excerpt budget', () => {
    const out = serializeForCompaction([toolMsg('read_file', { type: 'text', value: 'x'.repeat(5000) })]);
    const line = out.split('\n').find((l) => l.includes('[result of read_file]'))!;
    expect(line.length).toBeLessThan(400);
    expect(line).toMatch(/…$/);
  });

  it('collapses whitespace inside the excerpt', () => {
    const out = serializeForCompaction([
      toolMsg('grep', { type: 'text', value: 'a\n\n   b\t\tc' }),
    ]);
    expect(out).toContain('[result of grep] a b c');
  });

  it('keeps text items and skips images in multipart output', () => {
    const out = serializeForCompaction([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'screenshot',
            output: {
              type: 'content',
              value: [
                { type: 'text', text: 'captured the page' },
                { type: 'image-data', data: 'AAAA', mediaType: 'image/png' },
              ],
            },
          },
        ],
      } as ModelMessage,
    ]);
    expect(out).toContain('[result of screenshot] captured the page');
    expect(out).not.toContain('AAAA');
  });
});

describe('splitForTailPreservation', () => {
  it('snaps the tail to a user-message boundary', () => {
    // The last user turn carries enough weight (≥30% of total) to become the tail.
    const msgs: ModelMessage[] = [
      user('a'.repeat(50)),
      { role: 'assistant', content: 'b'.repeat(50) },
      user('c'.repeat(80)),
      { role: 'assistant', content: 'd'.repeat(10) },
    ];
    const { head, tail } = splitForTailPreservation(msgs, 0.3);
    expect(head).toEqual(msgs.slice(0, 2));
    expect(tail).toEqual(msgs.slice(2));
    expect(tail[0]?.role).toBe('user');
  });

  it('returns an empty tail when the split would leave nothing to summarize', () => {
    const msgs: ModelMessage[] = [user('only message')];
    const { head, tail } = splitForTailPreservation(msgs, 0.3);
    expect(head).toEqual(msgs);
    expect(tail).toEqual([]);
  });
});

describe('messageChars', () => {
  it('counts string content', () => {
    expect(messageChars(user('abcd'))).toBe(4);
  });

  it('counts tool output and call input in structured content', () => {
    expect(messageChars(toolMsg('grep', { type: 'text', value: 'abcdef' }))).toBe(6);
    expect(messageChars(assistantCall('grep'))).toBeGreaterThan(0);
  });
});
