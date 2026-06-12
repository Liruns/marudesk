import { describe, expect, it } from 'vitest';
import type { ToolResultPartLite } from './loop-helpers';
import {
  MAX_TURN_STEPS,
  STEP_WINDDOWN_AT,
  appendNoteToLastToolResult,
  stepLimitNote,
} from './turn-limits';

const textResult = (value: string): ToolResultPartLite => ({
  type: 'tool-result',
  toolCallId: 'c1',
  toolName: 'read_file',
  output: { type: 'text', value },
});

describe('stepLimitNote', () => {
  it('stays silent while the budget is comfortable', () => {
    expect(stepLimitNote(1)).toBeNull();
    expect(stepLimitNote(MAX_TURN_STEPS - STEP_WINDDOWN_AT - 1)).toBeNull();
  });

  it('starts winding down inside the threshold window', () => {
    const note = stepLimitNote(MAX_TURN_STEPS - STEP_WINDDOWN_AT);
    expect(note).toMatch(/\[limit\]/);
    expect(note).toContain(`at most ${STEP_WINDDOWN_AT} model steps remain`);
  });

  it('tells the model the next reply is the last one step before the cap', () => {
    const note = stepLimitNote(MAX_TURN_STEPS - 1);
    expect(note).toMatch(/NEXT reply is the last/);
    expect(note).toMatch(/Do not call more tools/);
  });

  it('returns null at and past the cap (the loop hard-stops instead)', () => {
    expect(stepLimitNote(MAX_TURN_STEPS)).toBeNull();
    expect(stepLimitNote(MAX_TURN_STEPS + 3)).toBeNull();
  });

  it('respects a custom max', () => {
    expect(stepLimitNote(2, 10)).toBeNull();
    expect(stepLimitNote(9, 10)).toMatch(/NEXT reply is the last/);
  });
});

describe('appendNoteToLastToolResult', () => {
  it('appends to a plain text result', () => {
    const parts = [textResult('a'), textResult('b')];
    appendNoteToLastToolResult(parts, '[limit] wrap up');
    expect(parts[0].output).toEqual({ type: 'text', value: 'a' });
    expect(parts[1].output).toEqual({ type: 'text', value: 'b\n\n[limit] wrap up' });
  });

  it('appends to an error result', () => {
    const parts: ToolResultPartLite[] = [
      { type: 'tool-result', toolCallId: 'c1', toolName: 'grep', output: { type: 'error-text', value: 'boom' } },
    ];
    appendNoteToLastToolResult(parts, 'note');
    expect(parts[0].output).toEqual({ type: 'error-text', value: 'boom\n\nnote' });
  });

  it('appends a text item to multipart (image) output', () => {
    const parts: ToolResultPartLite[] = [
      {
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'screenshot',
        output: {
          type: 'content',
          value: [
            { type: 'text', text: 'shot' },
            { type: 'image-data', data: 'AAAA', mediaType: 'image/png' },
          ],
        },
      },
    ];
    appendNoteToLastToolResult(parts, 'note');
    const out = parts[0].output;
    expect(out.type).toBe('content');
    if (out.type === 'content') {
      expect(out.value[out.value.length - 1]).toEqual({ type: 'text', text: 'note' });
    }
  });

  it('is a no-op on an empty step', () => {
    const parts: ToolResultPartLite[] = [];
    expect(() => appendNoteToLastToolResult(parts, 'note')).not.toThrow();
    expect(parts).toEqual([]);
  });
});
