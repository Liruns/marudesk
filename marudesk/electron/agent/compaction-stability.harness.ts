import type { ModelMessage } from 'ai';
import { check, passedCount } from '../harness-kit.ts';
import {
  repairToolPairs,
  extractFileManifest,
  formatFileManifest,
  stripFileManifest,
  pruneStaleToolOutputsInHead,
  capToolOutput,
  advanceDegradationMonitor,
  applyPersistentNudge,
  stripPersistentNudge,
  transcriptChars,
  largestMessageChars,
  emergencyCapToolResultsInPlace,
  POST_COMPACTION_NO_TEXT_THRESHOLD,
} from './compaction-utils.ts';
import { appendNoteToLastToolResult } from './turn-limits.ts';
import type { ToolResultPartLite } from './loop-helpers.ts';

/**
 * Harness for the compaction-stability batch (SECOND-PASS items 1, 3, 4, 5, 7).
 *
 * Pure + dependency-free, like the sibling `compaction-prune` harness:
 * `compaction-utils.ts` imports only `type ModelMessage` (erased at runtime), so
 * this runs standalone via `npm run harness:compaction-stability` under bare
 * `node --experimental-strip-types` — no Electron stub needed.
 *
 * Covers:
 *  - item 1: tool-pair orphan recovery — inject a placeholder for a dropped
 *    result, drop an orphaned result whose call is gone, and ALWAYS preserve
 *    pair integrity (every tool_use answered, no orphan results left).
 *  - item 4: file-operation manifest extraction (read vs modified, disjoint) and
 *    its `<read-files>` / `<modified-files>` rendering + strip round-trip.
 *  - item 5: pruning digest micro-summary (grep match counts, run_diagnostics
 *    error count, run_command/read_file line note) survives into the notice.
 *  - item 7: per-tool output cap — truncatable tools capped with a footer,
 *    read_file exempt (anchors), small outputs untouched, window-aware.
 *  - item 3: degradation monitor — fires after N consecutive no-text responses
 *    inside the window, inert outside it, reset by visible text.
 */

const txt = (n: number) => 'x'.repeat(n);

/* ── transcript-shape constructors ───────────────────────────────────────── */

function assistantCall(id: string, toolName: string, input: unknown): ModelMessage {
  return { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName, input }] };
}

function toolResult(id: string, toolName: string, value: string): ModelMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: id, toolName, output: { type: 'text', value } }],
  };
}

/** Every assistant tool-call id has exactly one matching tool-result id, and vice-versa. */
function pairsIntact(msgs: ModelMessage[]): boolean {
  const callIds: string[] = [];
  const resultIds: string[] = [];
  for (const m of msgs) {
    if (typeof m.content === 'string') continue;
    for (const p of m.content as ReadonlyArray<{ type: string; toolCallId?: string }>) {
      if (p.type === 'tool-call' && p.toolCallId) callIds.push(p.toolCallId);
      if (p.type === 'tool-result' && p.toolCallId) resultIds.push(p.toolCallId);
    }
  }
  const calls = new Set(callIds);
  const results = new Set(resultIds);
  if (calls.size !== results.size) return false;
  for (const id of calls) if (!results.has(id)) return false;
  for (const id of results) if (!calls.has(id)) return false;
  return true;
}

/** Collect every tool-result output across a transcript. */
function resultOutputs(msgs: ModelMessage[]): Array<{ type: string; value: unknown }> {
  const out: Array<{ type: string; value: unknown }> = [];
  for (const m of msgs) {
    if (m.role !== 'tool' || typeof m.content === 'string') continue;
    for (const p of m.content as ReadonlyArray<{ type: string; output?: { type: string; value: unknown } }>) {
      if (p.type === 'tool-result' && p.output) out.push(p.output);
    }
  }
  return out;
}

/* ── item 1: tool-pair orphan recovery ───────────────────────────────────── */
{
  // A clean transcript (every call answered) is returned untouched, pairs hold.
  const clean: ModelMessage[] = [
    { role: 'user', content: 'go' },
    assistantCall('c1', 'grep', { pattern: 'foo' }),
    toolResult('c1', 'grep', 'a match'),
  ];
  const r = repairToolPairs(clean);
  check('orphan-recovery: clean transcript → no injects', r.injectedResults === 0);
  check('orphan-recovery: clean transcript → no drops', r.droppedResults === 0);
  check('orphan-recovery: clean transcript pairs intact', pairsIntact(r.messages));
}
{
  // Class 1: an assistant tool-call whose paired result was dropped (lived in the
  // summarized head) → a synthetic placeholder result is injected right after.
  const orphanCall: ModelMessage[] = [
    { role: 'user', content: 'summary…' },
    { role: 'assistant', content: 'ok' },
    assistantCall('c9', 'read_file', { path: 'a.ts' }), // result was dropped
    { role: 'user', content: 'continue' },
  ];
  const r = repairToolPairs(orphanCall);
  check('orphan-recovery: dropped result → 1 placeholder injected', r.injectedResults === 1);
  check('orphan-recovery: class-1 pairs restored', pairsIntact(r.messages));
  const placeholder = resultOutputs(r.messages)[0];
  check(
    'orphan-recovery: placeholder text is the compaction marker',
    placeholder?.type === 'text' && placeholder.value === '[result omitted by compaction]',
  );
  // The injected tool message sits immediately after the orphaned assistant call.
  const idx = r.messages.findIndex((m) => m.role === 'tool');
  check('orphan-recovery: placeholder follows its assistant call', idx === 3);
}
{
  // Class 2: a tool-result whose paired tool-call was dropped (call lived in the
  // head) → the orphaned result part is removed; the now-empty tool message goes.
  const orphanResult: ModelMessage[] = [
    { role: 'user', content: 'summary…' },
    { role: 'assistant', content: 'ok' },
    toolResult('gone', 'grep', 'orphaned result — its call was summarized away'),
    { role: 'user', content: 'continue' },
  ];
  const r = repairToolPairs(orphanResult);
  check('orphan-recovery: orphaned result → 1 dropped', r.droppedResults === 1);
  check('orphan-recovery: class-2 leaves no tool messages', !r.messages.some((m) => m.role === 'tool'));
  check('orphan-recovery: class-2 pairs intact (none left)', pairsIntact(r.messages));
  check('orphan-recovery: class-2 keeps the user tail', r.messages[r.messages.length - 1].role === 'user');
}
{
  // Mixed multi-part tool message: one result keeps its call, one is orphaned →
  // the orphan part is dropped, the paired part survives, message not lost.
  const mixed: ModelMessage[] = [
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'k1', toolName: 'grep', input: { pattern: 'x' } }],
    },
    {
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: 'k1', toolName: 'grep', output: { type: 'text', value: 'kept' } },
        { type: 'tool-result', toolCallId: 'gone', toolName: 'grep', output: { type: 'text', value: 'orphan' } },
      ],
    },
  ];
  const r = repairToolPairs(mixed);
  check('orphan-recovery: mixed message → 1 orphan part dropped', r.droppedResults === 1);
  check('orphan-recovery: mixed message keeps the paired part', resultOutputs(r.messages).length === 1);
  check('orphan-recovery: mixed message pairs intact', pairsIntact(r.messages));
}
{
  // The original array is never mutated (a new array is returned).
  const input: ModelMessage[] = [assistantCall('c1', 'grep', { pattern: 'x' })];
  const r = repairToolPairs(input);
  check('orphan-recovery: input array untouched (length)', input.length === 1);
  check('orphan-recovery: returns a fresh array', r.messages !== input);
}

/* ── item 4: file-operation manifest ─────────────────────────────────────── */
{
  const head: ModelMessage[] = [
    assistantCall('r1', 'read_file', { path: 'src/a.ts' }),
    toolResult('r1', 'read_file', 'contents'),
    assistantCall('r2', 'read_file', { path: 'src/b.ts' }),
    toolResult('r2', 'read_file', 'contents'),
    assistantCall('e1', 'edit_file', { path: 'src/b.ts', oldString: 'x', newString: 'y' }),
    toolResult('e1', 'edit_file', 'edited'),
    assistantCall('m1', 'multi_edit', {
      edits: [{ path: 'src/c.ts', oldString: 'p', newString: 'q' }],
    }),
    toolResult('m1', 'multi_edit', 'edited'),
  ];
  const manifest = extractFileManifest(head);
  // b.ts was read AND edited → counts only as modified (lists are disjoint).
  check('manifest: read-only files = [src/a.ts]', JSON.stringify(manifest.readFiles) === JSON.stringify(['src/a.ts']));
  check(
    'manifest: modified files = [src/b.ts, src/c.ts]',
    JSON.stringify(manifest.modifiedFiles) === JSON.stringify(['src/b.ts', 'src/c.ts']),
  );
  const rendered = formatFileManifest(manifest);
  check('manifest: renders <read-files> block', rendered.includes('<read-files>') && rendered.includes('- src/a.ts'));
  check(
    'manifest: renders <modified-files> block',
    rendered.includes('<modified-files>') && rendered.includes('- src/b.ts') && rendered.includes('- src/c.ts'),
  );
  // strip removes the tags so a merge pass doesn't stack stale manifests.
  const summary = `Prose summary line.\n\n${rendered}`;
  check('manifest: strip removes tag blocks', stripFileManifest(summary) === 'Prose summary line.');
}
{
  // No file ops → empty manifest renders to '' (no stray tags).
  const head: ModelMessage[] = [
    { role: 'user', content: 'just chat' },
    { role: 'assistant', content: 'sure' },
  ];
  const manifest = extractFileManifest(head);
  check('manifest: no file ops → empty lists', manifest.readFiles.length === 0 && manifest.modifiedFiles.length === 0);
  check('manifest: empty manifest renders to empty string', formatFileManifest(manifest) === '');
}

/* ── item 5: pruning digest micro-summary ────────────────────────────────── */
{
  // A grep superseded by a later grep of the same pattern is pruned, and its
  // notice carries a match/file digest instead of a bare freed-chars line.
  const grepBody = Array.from({ length: 40 }, (_, i) => `src/file${i % 3}.ts:${i}: hit`).join('\n') + '\n' + txt(6000);
  const head: ModelMessage[] = [
    assistantCall('g1', 'grep', { pattern: 'foo' }),
    toolResult('g1', 'grep', grepBody), // superseded → pruned with digest
    assistantCall('g2', 'grep', { pattern: 'foo' }),
    toolResult('g2', 'grep', 'latest'),
    assistantCall('f1', 'read_file', { path: 'z.ts' }),
    toolResult('f1', 'read_file', txt(9000)), // filler clears protect window
  ];
  const r = pruneStaleToolOutputsInHead(head);
  check('digest: grep superseded → pruned', r.prunedCount >= 1);
  const grepNotice = resultOutputs(head)[0];
  check('digest: grep notice mentions match lines', typeof grepNotice.value === 'string' && /match line/.test(grepNotice.value));
  check('digest: grep notice mentions file count', typeof grepNotice.value === 'string' && /file\(s\)/.test(grepNotice.value));
}
{
  // run_diagnostics superseded → digest keeps the error count + first error.
  const diagBody = ['src/a.ts:12 error TS2345 mismatch', 'src/b.ts:3 error TS1005 expected', txt(6000)].join('\n');
  const head: ModelMessage[] = [
    assistantCall('d1', 'run_diagnostics', {}),
    toolResult('d1', 'run_diagnostics', diagBody), // superseded → pruned with digest
    assistantCall('d2', 'run_diagnostics', {}),
    toolResult('d2', 'run_diagnostics', 'clean'),
    assistantCall('f1', 'read_file', { path: 'z.ts' }),
    toolResult('f1', 'read_file', txt(9000)),
  ];
  pruneStaleToolOutputsInHead(head);
  const diagNotice = resultOutputs(head)[0];
  check('digest: diagnostics notice counts errors', typeof diagNotice.value === 'string' && /2 diagnostic\(s\)/.test(diagNotice.value));
  check('digest: diagnostics notice keeps first error', typeof diagNotice.value === 'string' && /TS2345/.test(diagNotice.value));
}
{
  // The digest never inflates the notice past the original: charsSaved stays > 0.
  const head: ModelMessage[] = [
    assistantCall('g1', 'grep', { pattern: 'p' }),
    toolResult('g1', 'grep', 'a:1: x\n' + txt(8000)),
    assistantCall('g2', 'grep', { pattern: 'p' }),
    toolResult('g2', 'grep', 'b:2: y'),
    assistantCall('f1', 'read_file', { path: 'z.ts' }),
    toolResult('f1', 'read_file', txt(9000)),
  ];
  const r = pruneStaleToolOutputsInHead(head);
  check('digest: pruning still saves chars with a digest notice', r.charsSaved > 0);
}

/* ── item 7: per-tool output cap ─────────────────────────────────────────── */
{
  const big = txt(300_000); // ~75k tokens, over the 50k default ceiling
  const grepCap = capToolOutput('grep', big, 200_000);
  check('cap: large grep result is truncated', grepCap.truncated);
  check('cap: truncated grep is shorter than the input', grepCap.text.length < big.length);
  check('cap: truncated grep carries the footer', grepCap.text.includes('[output truncated'));
  // read_file is exempt — its anchor-bearing content must reach the model intact.
  const readCap = capToolOutput('read_file', big, 200_000);
  check('cap: read_file is exempt (never truncated)', !readCap.truncated && readCap.text === big);
  // A small result is left byte-identical.
  const small = capToolOutput('grep', 'tiny', 200_000);
  check('cap: small result untouched', !small.truncated && small.text === 'tiny');
  // Window-aware: a tiny window caps tighter than the default ceiling.
  const tightWindow = capToolOutput('grep', txt(200_000), 60_000); // window/3 = 20k tokens = 80k chars
  check('cap: small window tightens the cap', tightWindow.truncated && tightWindow.text.length < 100_000);
  // An unknown context window falls back to the default ceiling (no crash).
  const noWindow = capToolOutput('grep', txt(10_000), undefined);
  check('cap: undefined window uses default ceiling (no truncation under it)', !noWindow.truncated);
  // Default-cap policy: an UNKNOWN / MCP / plugin tool name is now capped too,
  // so one oversized result can't slip past the allowlist and eat the window.
  const mcpCap = capToolOutput('mcp__foo__bar', big, 200_000);
  check('cap: unknown MCP tool result is truncated', mcpCap.truncated);
  check('cap: truncated MCP result carries the footer', mcpCap.text.includes('[output truncated'));
  const readSession = capToolOutput('read_session', big, 200_000);
  check('cap: read_session (formerly uncapped) is now truncated', readSession.truncated);
  // Control tools stay exempt — they return tiny structured payloads, not bulk.
  const askUser = capToolOutput('ask_user', big, 200_000);
  check('cap: ask_user is exempt (never truncated)', !askUser.truncated && askUser.text === big);
  const updatePlan = capToolOutput('update_plan', big, 200_000);
  check('cap: update_plan is exempt (never truncated)', !updatePlan.truncated && updatePlan.text === big);
}

/* ── item 3: degradation monitor ─────────────────────────────────────────── */
{
  // Inside the window, N consecutive no-text responses cross the threshold.
  let state = { monitorRemaining: 5, emptyStreak: 0 };
  let degradedAt = -1;
  for (let i = 0; i < POST_COMPACTION_NO_TEXT_THRESHOLD; i++) {
    const adv = advanceDegradationMonitor(state, false);
    state = adv.state;
    if (adv.degraded && degradedAt === -1) degradedAt = i;
  }
  check('monitor: fires exactly at the no-text threshold', degradedAt === POST_COMPACTION_NO_TEXT_THRESHOLD - 1);
}
{
  // Visible text resets the streak so the threshold is never reached.
  let state = { monitorRemaining: 5, emptyStreak: 0 };
  let everDegraded = false;
  const pattern = [false, false, true, false, false]; // text on the 3rd response
  for (const hasText of pattern) {
    const adv = advanceDegradationMonitor(state, hasText);
    state = adv.state;
    everDegraded = everDegraded || adv.degraded;
  }
  check('monitor: visible text resets the streak (never degraded)', !everDegraded);
}
{
  // Outside the window (monitorRemaining 0) the monitor is inert — a healthy long
  // tool-only stretch never trips it.
  const adv = advanceDegradationMonitor({ monitorRemaining: 0, emptyStreak: 9 }, false);
  check('monitor: inert when window is closed', !adv.degraded);
  check('monitor: closed window state is unchanged', adv.state.monitorRemaining === 0 && adv.state.emptyStreak === 9);
}

/* ── persistent nudge survives the compaction boundary ───────────────────── */
{
  // Simulate the compaction rebuild: a leading summary user message, an assistant
  // ack, then a verbatim tail. A not-yet-acted-on recovery nudge stamped here
  // must survive verbatim — the whole point of the compaction-protected channel
  // (a prunable tool-result nudge would be summarized away instead).
  const nudge = '[recovery] tool calls keep failing this turn. Take a different approach.';
  const rebuilt: ModelMessage[] = [
    { role: 'user', content: 'Summary of earlier conversation: explored the repo.' },
    { role: 'assistant', content: 'Understood — continuing.' },
    { role: 'user', content: 'keep going' },
    assistantCall('c1', 'grep', { pattern: 'foo' }),
    toolResult('c1', 'grep', 'a match'),
  ];
  // The boundary repair runs first (pairs must stay intact), THEN the nudge is
  // stamped — exactly the order compactConversation uses.
  const repaired = repairToolPairs(rebuilt);
  const withNudge = applyPersistentNudge(repaired.messages, nudge);
  const head = withNudge[0];
  const headText = typeof head.content === 'string' ? head.content : '';
  check('persistent-nudge: survives the boundary verbatim', headText.includes(nudge));
  check('persistent-nudge: stamped in a protected block', headText.includes('<persistent-nudge>'));
  check('persistent-nudge: pairs stay intact after stamping', pairsIntact(withNudge));
  check(
    'persistent-nudge: the verbatim tail is untouched',
    withNudge[withNudge.length - 1].role === 'tool',
  );

  // A null nudge (model has recovered) clears the block and is a no-op otherwise.
  const cleared = applyPersistentNudge(withNudge, null);
  const clearedText = typeof cleared[0].content === 'string' ? cleared[0].content : '';
  check('persistent-nudge: a null nudge clears the protected block', !clearedText.includes('<persistent-nudge>'));
  check(
    'persistent-nudge: clearing preserves the summary prose',
    clearedText === 'Summary of earlier conversation: explored the repo.',
  );

  // A merge pass must strip a stale block from the prior summary before feeding it
  // to the summarizer, so a not-yet-acted nudge is never re-summarized as history.
  check(
    'persistent-nudge: strip removes the block from a prior summary body',
    stripPersistentNudge(`prior summary text\n\n<persistent-nudge>\n${nudge}\n</persistent-nudge>`) ===
      'prior summary text',
  );

  // Refresh (not stack): a second nudge replaces the first — only one block lives.
  const refreshed = applyPersistentNudge(withNudge, 'a newer nudge');
  const refreshedText = typeof refreshed[0].content === 'string' ? refreshed[0].content : '';
  check('persistent-nudge: refresh replaces the prior nudge', refreshedText.includes('a newer nudge') && !refreshedText.includes(nudge));
  check('persistent-nudge: exactly one block after refresh', (refreshedText.match(/<persistent-nudge>/g)?.length ?? 0) === 1);
}

/* ── rank 15: overflow no-progress detection + emergency hard-cap ─────────── */
{
  // transcriptChars sums every message; largestMessageChars finds the single
  // biggest — the overflow handler uses both to detect a tail compaction can't
  // shrink (one verbatim message already over the model window).
  const msgs: ModelMessage[] = [
    { role: 'user', content: 'go' },
    toolResult('c1', 'grep', txt(100)),
  ];
  check('overflow: transcriptChars sums message weights', transcriptChars(msgs) === 2 + 100);
  check('overflow: largestMessageChars finds the biggest', largestMessageChars(msgs) === 100);
  check('overflow: largestMessageChars of [] is 0', largestMessageChars([]) === 0);
}
{
  // The no-progress predicate the handler evaluates: a single verbatim-tail
  // tool-result whose char weight exceeds the model window (tokens * 4 chars).
  const window = 200_000;
  const windowChars = window * 4; // 800k
  const tail: ModelMessage[] = [
    { role: 'user', content: 'continue' },
    assistantCall('c1', 'read_file', { path: 'big.ts' }),
    toolResult('c1', 'read_file', txt(1_000_000)), // > windowChars → un-shrinkable
  ];
  check('overflow: an oversized verbatim tail exceeds the window-in-chars', largestMessageChars(tail) > windowChars);
}
{
  // (b) Graceful degradation: emergencyCapToolResultsInPlace caps the oversized
  // read_file tool-result (dropping the read_file exemption for this emergency)
  // so the tail fits — the retry can proceed instead of re-overflowing forever.
  const window = 20_000;
  const windowChars = window * 4; // 80k
  const before: ModelMessage[] = [
    { role: 'user', content: 'go' },
    assistantCall('c1', 'read_file', { path: 'big.ts' }),
    toolResult('c1', 'read_file', 'line\n'.repeat(200_000)), // 1M chars
  ];
  check('overflow: oversized read tail before cap exceeds the window', largestMessageChars(before) > windowChars);
  const res = emergencyCapToolResultsInPlace(before, window);
  check('overflow: emergency cap truncates the oversized read', res.cappedCount === 1 && res.charsSaved > 0);
  check('overflow: tail now fits under the window after the cap', largestMessageChars(before) <= windowChars);
  check('overflow: pairing intact after the emergency cap', pairsIntact(before));
}
{
  // (a) Even a hard cap can't help when the oversized message is plain
  // user/assistant TEXT (no tool-result to cap) — the handler then surfaces a
  // specific error instead of a pointless second compaction + failover.
  const window = 10_000;
  const windowChars = window * 4; // 40k
  const untouchable: ModelMessage[] = [
    { role: 'user', content: txt(500_000) }, // one oversized user message
    { role: 'assistant', content: 'ok' },
  ];
  check('overflow: oversized user text exceeds the window', largestMessageChars(untouchable) > windowChars);
  const res = emergencyCapToolResultsInPlace(untouchable, window);
  check('overflow: nothing to cap → cappedCount 0 (handler surfaces the specific error)', res.cappedCount === 0);
  check('overflow: still over window after a no-op cap', largestMessageChars(untouchable) > windowChars);
  // A control-tool payload is also left intact even in the emergency pass.
  const ctrl: ModelMessage[] = [assistantCall('p1', 'update_plan', {}), toolResult('p1', 'update_plan', txt(500_000))];
  check('overflow: control-tool payload stays uncapped under emergency', emergencyCapToolResultsInPlace(ctrl, window).cappedCount === 0);
}

/* ── rank 17: degradation note rides on the last tool-result ──────────────── */
{
  // The post-compaction degradation note must fold into the LAST tool-result
  // (the same channel the wind-down note uses) — NOT a standalone `[system]`
  // user message — so the message count stays stable (the prefix-cache
  // breakpoint at messages.length-2 doesn't shift) and the tail-split has no
  // false synthetic `user` boundary to snap to.
  const parts: ToolResultPartLite[] = [
    { type: 'tool-result', toolCallId: 'a1', toolName: 'grep', output: { type: 'text', value: 'first result' } },
    { type: 'tool-result', toolCallId: 'a2', toolName: 'read_file', output: { type: 'text', value: 'second result' } },
  ];
  const note = '[system] You have produced several responses with no explanation since the last context compaction.';
  appendNoteToLastToolResult(parts, note);
  const last = parts[parts.length - 1];
  const lastText = last.output.type === 'text' ? last.output.value : '';
  check('degradation-note: rides on the LAST tool-result', lastText.includes(note));
  check('degradation-note: does NOT touch earlier results', parts[0].output.type === 'text' && parts[0].output.value === 'first result');
  check('degradation-note: adds NO standalone message (part count unchanged)', parts.length === 2);
}
{
  // Multipart (content) last result: the note appends as a text item, not a
  // string concat — the screenshot-tool shape still receives the note.
  const parts: ToolResultPartLite[] = [
    {
      type: 'tool-result',
      toolCallId: 's1',
      toolName: 'screenshot',
      output: { type: 'content', value: [{ type: 'text', text: 'shot taken' }] },
    },
  ];
  appendNoteToLastToolResult(parts, '[system] re-state what you are doing');
  const out = parts[0].output;
  const hasNoteItem =
    out.type === 'content' &&
    out.value.some((v) => v.type === 'text' && v.text.includes('re-state what you are doing'));
  check('degradation-note: folds into a multipart content result as a text item', hasNoteItem);
}

console.log(`\n${passedCount()} checks passed`);
