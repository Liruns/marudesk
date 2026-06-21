import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import {
  messageChars,
  serializeForCompaction,
  splitForTailPreservation,
  applyPersistentNudge,
  stripPersistentNudge,
  capToolOutput,
  pruneStaleToolOutputsInHead,
  transcriptChars,
  largestMessageChars,
  emergencyCapToolResultsInPlace,
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

  it('keeps both head and tail of a long error result so the signature survives', () => {
    // A long stack/diff where the signature lives at the END of the text.
    const head = 'STACKSTART '.repeat(80); // ~880 chars of leading noise
    const middle = 'frame '.repeat(400); // bulk that should be elided
    const value = `${head}${middle}Error: ENOENT signature at tail`;
    const out = serializeForCompaction([
      toolMsg('run_command', { type: 'error-text', value }),
    ]);
    const line = out.split('\n').find((l) => l.includes('[result of run_command]'))!;
    // Head survives.
    expect(line).toContain('STACKSTART');
    // Tail signature survives — this is the whole point of the larger budget.
    expect(line).toContain('Error: ENOENT signature at tail');
    // Middle is elided with a marker.
    expect(line).toContain('chars elided');
    // Bounded near the error budget (1500) + framing, not the raw input length.
    expect(line.length).toBeLessThan(1700);
    expect(value.length).toBeGreaterThan(1700);
  });

  it('still clips an ordinary result to ~300 head-only', () => {
    const out = serializeForCompaction([
      toolMsg('read_file', { type: 'text', value: 'y'.repeat(5000) }),
    ]);
    const line = out.split('\n').find((l) => l.includes('[result of read_file]'))!;
    // No head+tail elision marker for non-error results.
    expect(line).not.toContain('chars elided');
    expect(line).toMatch(/…$/);
    // Bounded near the 300 head-only budget, not the larger error budget.
    expect(line.length).toBeLessThan(400);
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
  // A screenshot tool result: multipart 'content' output whose `value` is an
  // ARRAY of a text part + an inline base64 image part.
  const screenshotMsg = (text: string, data: string): ModelMessage => ({
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'screenshot',
        output: {
          type: 'content',
          value: [
            { type: 'text', text },
            { type: 'image-data', data, mediaType: 'image/png' },
          ],
        },
      },
    ],
  });

  it('counts string content', () => {
    expect(messageChars(user('abcd'))).toBe(4);
  });

  it('counts tool output and call input in structured content', () => {
    expect(messageChars(toolMsg('grep', { type: 'text', value: 'abcdef' }))).toBe(6);
    expect(messageChars(assistantCall('grep'))).toBeGreaterThan(0);
  });

  it('counts a multipart screenshot result (text part + inline base64) instead of weighing it 0', () => {
    const text = 'captured the page';
    const data = 'A'.repeat(200_000); // hundreds of KB of inline base64
    // Without the array branch this whole result weighs 0; with it the result
    // contributes text.length + data.length.
    expect(messageChars(screenshotMsg(text, data))).toBe(text.length + data.length);
  });

  it('largestMessageChars now reflects a big screenshot (no longer undercounts vision turns)', () => {
    const data = 'A'.repeat(1_000_000);
    const msgs: ModelMessage[] = [
      user('go'),
      assistantCall('screenshot'),
      screenshotMsg('captured', data),
    ];
    expect(largestMessageChars(msgs)).toBe('captured'.length + data.length);
  });
});

describe('persistent nudge (compaction-protected)', () => {
  // The post-compaction transcript shape: a leading summary user message, an
  // assistant ack, then the verbatim tail.
  const rebuilt = (): ModelMessage[] => [
    user('Summary of earlier conversation: did X, Y.'),
    { role: 'assistant', content: 'Understood — continuing.' },
    user('keep going'),
  ];

  it('stamps the nudge onto the leading summary message so it survives the boundary', () => {
    const out = applyPersistentNudge(rebuilt(), '[recovery] edit_file failed twice — re-read the file.');
    const head = out[0];
    expect(typeof head.content === 'string' && head.content).toContain('<persistent-nudge>');
    expect(typeof head.content === 'string' && head.content).toContain('[recovery] edit_file failed twice');
    // The other turns are untouched.
    expect(out[1]).toEqual(rebuilt()[1]);
    expect(out[2]).toEqual(rebuilt()[2]);
  });

  it('is a no-op for a null nudge and returns the same reference', () => {
    const msgs = rebuilt();
    expect(applyPersistentNudge(msgs, null)).toBe(msgs);
    expect(applyPersistentNudge(msgs, '   ')).toBe(msgs);
  });

  it('refreshes rather than stacks: a second nudge replaces the first', () => {
    const once = applyPersistentNudge(rebuilt(), 'first nudge');
    const twice = applyPersistentNudge(once, 'second nudge');
    const head = twice[0];
    const text = typeof head.content === 'string' ? head.content : '';
    expect(text).toContain('second nudge');
    expect(text).not.toContain('first nudge');
    // Exactly one block survives.
    expect(text.match(/<persistent-nudge>/g)?.length).toBe(1);
  });

  it('clears the block when the model recovers (null after a prior stamp)', () => {
    const stamped = applyPersistentNudge(rebuilt(), 'nudge');
    const cleared = applyPersistentNudge(stamped, null);
    const head = cleared[0];
    const text = typeof head.content === 'string' ? head.content : '';
    expect(text).not.toContain('<persistent-nudge>');
    // The summary prose itself is preserved intact.
    expect(text).toBe('Summary of earlier conversation: did X, Y.');
  });

  it('strips a block from arbitrary text, leaving surrounding prose', () => {
    const withBlock = 'prose before\n\n<persistent-nudge>\nnudge text\n</persistent-nudge>';
    expect(stripPersistentNudge(withBlock)).toBe('prose before');
    // Idempotent on text with no block.
    expect(stripPersistentNudge('just prose')).toBe('just prose');
  });

  it('strips only the real (appended-last) block when prose echoes the open sentinel', () => {
    // The summarized prose can echo the literal open marker. The real block is
    // always appended at the tail, so the strip anchors to the LAST open marker:
    // a first-match indexOf would delete from the prose marker THROUGH the real
    // block's close, corrupting the summary between them.
    const prose = 'summary head mentions <persistent-nudge> in passing';
    const text = `${prose}\n\n<persistent-nudge>\nlive nudge\n</persistent-nudge>`;
    expect(stripPersistentNudge(text)).toBe(prose);
  });

  it('leaves the transcript unchanged when there is no string user head', () => {
    const noHead: ModelMessage[] = [assistantCall('grep'), toolMsg('grep', { type: 'text', value: 'x' })];
    expect(applyPersistentNudge(noHead, 'nudge')).toBe(noHead);
  });
});

describe('pruneStaleToolOutputsInHead — external-tool supersession', () => {
  // Build a [assistant tool-call, tool tool-result] pair for one external call.
  const big = (n: number): string => 'x'.repeat(n);
  const pair = (callId: string, toolName: string, input: unknown, value: string): ModelMessage[] => [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: callId, toolName, input }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: callId, toolName, output: { type: 'text', value } }] },
  ];

  it('does NOT prune an earlier empty-args external poll (distinct snapshots)', () => {
    // Two repeated `{}` polls of an external tool, then a large trailing filler so
    // both polls sit outside the recency-protect window. Because empty-args
    // external calls return no target key, the older poll is NOT superseded.
    const head: ModelMessage[] = [
      ...pair('c1', 'srv__list_items', {}, big(10_000)),
      ...pair('c2', 'srv__list_items', {}, big(10_000)),
      ...pair('c3', 'srv__list_items', {}, big(10_000)),
    ];
    const before = head.map((m) => JSON.stringify(m.content));
    const r = pruneStaleToolOutputsInHead(head);
    expect(r.prunedCount).toBe(0);
    // Outputs are untouched (no supersession occurred).
    expect(head.map((m) => JSON.stringify(m.content))).toEqual(before);
  });

  it('DOES prune an earlier identical NON-empty external call (superseded)', () => {
    // Same external tool with identical NON-empty args: the later result
    // supersedes the earlier one, so the older bulky output is pruned to a notice.
    const head: ModelMessage[] = [
      ...pair('c1', 'srv__list_items', { cursor: 'a' }, big(10_000)),
      ...pair('c2', 'srv__list_items', { cursor: 'a' }, big(10_000)),
      ...pair('c3', 'srv__list_items', { cursor: 'a' }, big(10_000)),
    ];
    const r = pruneStaleToolOutputsInHead(head);
    expect(r.prunedCount).toBeGreaterThan(0);
    // The newest result for the target is never pruned.
    const lastTool = head[head.length - 1];
    const lastVal =
      typeof lastTool.content !== 'string'
        ? (lastTool.content as ReadonlyArray<{ type: string; output?: { value?: unknown } }>)[0].output?.value
        : undefined;
    expect(lastVal).toBe(big(10_000));
  });
});

describe('capToolOutput', () => {
  // The footer the cap appends; everything before it is the kept tool output.
  const FOOTER_MARK = '[output truncated';
  const keptOf = (text: string): string => {
    const i = text.indexOf(FOOTER_MARK);
    // The footer is preceded by "\n\n"; strip that separator too.
    return i === -1 ? text : text.slice(0, i).replace(/\n\n$/, '');
  };
  // Default cap = 50_000 tokens * 4 chars/token. Build inputs that exceed it.
  const DEFAULT_MAX_CHARS = 50_000 * 4;

  it('caps a grep result on a whole-line boundary (no partial last line) within budget', () => {
    // Many short, newline-terminated "match" lines that overflow the budget.
    const line = 'src/foo.ts:42:  const matched = findThing();';
    const lines: string[] = [];
    while (lines.join('\n').length <= DEFAULT_MAX_CHARS + line.length * 4) {
      lines.push(`${line}#${lines.length}`);
    }
    const input = lines.join('\n');
    const { text, truncated } = capToolOutput('grep', input, undefined);
    expect(truncated).toBe(true);
    const kept = keptOf(text);
    // The kept output never ends mid-line: it ends exactly on a full line that
    // is present verbatim in the original input.
    const keptLines = kept.split('\n');
    const lastKept = keptLines[keptLines.length - 1];
    expect(input.split('\n')).toContain(lastKept);
    // And the budget invariant holds: kept output stays within maxChars.
    expect(kept.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS);
  });

  it('caps a run_command result on a newline boundary so no half-line leaks', () => {
    const line = 'INFO build step completed for module number';
    const lines: string[] = [];
    while (lines.join('\n').length <= DEFAULT_MAX_CHARS * 1.2) {
      lines.push(`${line} ${lines.length}`);
    }
    const input = lines.join('\n');
    const { text, truncated } = capToolOutput('run_command', input, undefined);
    expect(truncated).toBe(true);
    const kept = keptOf(text);
    // Every kept line (ignoring the in-band elision marker) is a whole line from
    // the source — none is a truncated fragment of the line after it.
    for (const k of kept.split('\n')) {
      if (k.length === 0 || k.startsWith('…') || k.includes('elided')) continue;
      expect(input.includes(k)).toBe(true);
    }
    expect(kept.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS);
  });

  it('keeps read_file exempt — never capped even when huge', () => {
    const input = 'x'.repeat(DEFAULT_MAX_CHARS * 2);
    const { text, truncated } = capToolOutput('read_file', input, undefined);
    expect(truncated).toBe(false);
    expect(text).toBe(input);
  });

  it('hard-caps at maxChars when there is no newline before the cut', () => {
    // One enormous single line: no newline in range, so the fall-back hard cut
    // applies and the kept output is bounded by the budget.
    const input = 'a'.repeat(DEFAULT_MAX_CHARS * 2);
    const { text, truncated } = capToolOutput('mcp_tool', input, undefined);
    expect(truncated).toBe(true);
    const kept = keptOf(text);
    expect(kept.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS);
    expect(kept.length).toBeGreaterThan(0);
    // The footer still reports the elision against the full input length.
    expect(text).toContain(`of ${input.length} chars elided`);
  });

  it('footer "dropped of total" share ONE unit even for astral content', () => {
    // Astral code points (emoji) are 2 UTF-16 code units each. The cut budget
    // (maxChars) and droppedChars are measured in code units (.length); the
    // total must use the SAME unit so droppedChars can never exceed total.
    const astral = '😀'.repeat(DEFAULT_MAX_CHARS); // length is 2x its code-point count
    const { text, truncated } = capToolOutput('mcp_tool', astral, undefined);
    expect(truncated).toBe(true);
    const m = /(\d+) of (\d+) chars elided/.exec(text);
    expect(m).not.toBeNull();
    if (m) {
      const dropped = Number(m[1]);
      const total = Number(m[2]);
      // One unit: total is the full code-UNIT length, and dropped never exceeds it.
      expect(total).toBe(astral.length);
      expect(dropped).toBeLessThanOrEqual(total);
    }
  });

  it('caps read_file under `emergency` (the overflow last resort) but keeps control tools exempt', () => {
    const huge = 'x'.repeat(50_000 * 4 * 2);
    // Default path: read_file is exempt (anchor-bearing) — never capped.
    expect(capToolOutput('read_file', huge, undefined).truncated).toBe(false);
    // Emergency path: read_file IS capped so an oversized tail read can't
    // re-overflow the retry forever.
    const emergency = capToolOutput('read_file', huge, undefined, { emergency: true });
    expect(emergency.truncated).toBe(true);
    expect(emergency.text.length).toBeLessThan(huge.length);
    // Control payloads stay exempt even under emergency.
    expect(capToolOutput('update_plan', huge, undefined, { emergency: true }).truncated).toBe(false);
    expect(capToolOutput('ask_user', huge, undefined, { emergency: true }).truncated).toBe(false);
  });
});

describe('transcriptChars / largestMessageChars (overflow no-progress signal)', () => {
  it('transcriptChars sums every message weight', () => {
    const msgs: ModelMessage[] = [user('abcd'), toolMsg('grep', { type: 'text', value: 'abcdef' })];
    expect(transcriptChars(msgs)).toBe(4 + 6);
  });

  it('largestMessageChars returns the single biggest message (0 for empty)', () => {
    expect(largestMessageChars([])).toBe(0);
    const msgs: ModelMessage[] = [
      user('ab'),
      toolMsg('grep', { type: 'text', value: 'x'.repeat(500) }),
      user('abcd'),
    ];
    expect(largestMessageChars(msgs)).toBe(500);
  });

  it('flags an un-shrinkable verbatim tail: one tool-result exceeds the window-in-chars', () => {
    // A 200k-token window → 800k chars. A single 1M-char tool result on the
    // tail exceeds it, so compaction (which keeps a verbatim tail) frees nothing
    // usable — the overflow handler short-circuits on exactly this predicate.
    const windowChars = 200_000 * 4;
    const tail: ModelMessage[] = [
      user('go'),
      assistantCall('read_file'),
      toolMsg('read_file', { type: 'text', value: 'x'.repeat(1_000_000) }),
    ];
    expect(largestMessageChars(tail) > windowChars).toBe(true);
  });
});

describe('emergencyCapToolResultsInPlace (overflow graceful degradation)', () => {
  it('caps an oversized read_file tool-result in place so the tail fits, keeping pairing', () => {
    const window = 20_000; // 20k tokens → maxChars ~ floor(20000/3)*4 = 26_668
    const windowChars = window * 4;
    const oversized = 'line\n'.repeat(200_000); // 1M chars, well over windowChars
    const msgs: ModelMessage[] = [
      user('go'),
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'read_file', input: { path: 'big.ts' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'read_file', output: { type: 'text', value: oversized } }] },
    ];
    expect(largestMessageChars(msgs) > windowChars).toBe(true);

    const res = emergencyCapToolResultsInPlace(msgs, window);
    expect(res.cappedCount).toBe(1);
    expect(res.charsSaved).toBeGreaterThan(0);
    // The tail now fits under the window — the retry can proceed instead of
    // overflowing again.
    expect(largestMessageChars(msgs) <= windowChars).toBe(true);
    // Pairing intact: still exactly one tool-result for the same call id.
    const toolMsgContent = msgs[2].content;
    expect(Array.isArray(toolMsgContent)).toBe(true);
    if (Array.isArray(toolMsgContent)) {
      expect(toolMsgContent).toHaveLength(1);
      const part = toolMsgContent[0];
      expect(part.type === 'tool-result' && part.toolCallId).toBe('c1');
    }
  });

  it('is a no-op when nothing exceeds the budget (cappedCount 0)', () => {
    const msgs: ModelMessage[] = [
      user('go'),
      assistantCall('grep'),
      toolMsg('grep', { type: 'text', value: 'a few short matches' }),
    ];
    const res = emergencyCapToolResultsInPlace(msgs, 200_000);
    expect(res).toEqual({ cappedCount: 0, charsSaved: 0 });
  });

  it('leaves a control-tool payload uncapped even in the emergency pass', () => {
    const huge = 'x'.repeat(50_000 * 4 * 2);
    const msgs: ModelMessage[] = [
      user('go'),
      assistantCall('update_plan'),
      toolMsg('update_plan', { type: 'text', value: huge }),
    ];
    const res = emergencyCapToolResultsInPlace(msgs, 1000);
    expect(res.cappedCount).toBe(0);
  });
});
