import type { ModelMessage } from 'ai';
import { check, passedCount } from '../harness-kit.ts';
import { pruneStaleToolOutputsInHead } from './compaction-utils.ts';

/**
 * Harness for COMPACT-1 staleness-aware tool-output pruning
 * (docs/agent-port-plan.md → "COMPACT-1 — Staleness-aware tool-output pruning
 * (요약 전)").
 *
 * Pure + dependency-free: `compaction-utils.ts` imports only `type ModelMessage`
 * (stripped at runtime) plus the pure value `toolCallSignature` from
 * `./loop-detector.ts`, so this runs standalone via
 * `npm run harness:compaction-prune` under bare
 * `node --experimental-strip-types` — no Electron stub needed.
 *
 * Covers the doc's acceptance criteria: no-op below the savings floor; a
 * superseded read is pruned; an edit invalidates an earlier read of the file;
 * the LATEST read per path is never pruned; the protect window (stale-inside IS
 * pruned, non-stale is not); grep superseded; run_diagnostics superseded; an
 * error-text result is never tracked; and the pairing invariant (every
 * tool-call still has its tool-result, multi-part handled) is preserved.
 */

/* ── constants used to size payloads ─────────────────────────────────────── */
// Knobs inside compaction-utils: PROTECT=8000, MIN_SAVINGS=4000, DIGEST=120.
const BIG = 6000; // > DIGEST, and two of them clear the 4000-char savings floor
const HUGE = 9000; // alone enough to clear the protect window + savings floor

const txt = (n: number) => 'x'.repeat(n);

/* ── transcript-shape constructors ───────────────────────────────────────── */

function assistantCall(id: string, toolName: string, input: unknown): ModelMessage {
  return { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName, input }] };
}

function toolResult(
  id: string,
  toolName: string,
  value: string,
  outType: 'text' | 'error-text' = 'text',
): ModelMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: id, toolName, output: { type: outType, value } }],
  };
}

/** Pull every tool-result part's output out of a transcript for assertions. */
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

const isPruned = (o: { type: string; value: unknown }): boolean =>
  o.type === 'text' && typeof o.value === 'string' && o.value.startsWith('[output pruned');

/** Assert every assistant tool-call still has a paired tool-result by id. */
function pairsIntact(msgs: ModelMessage[]): boolean {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const m of msgs) {
    if (typeof m.content === 'string') continue;
    for (const p of m.content as ReadonlyArray<{ type: string; toolCallId?: string }>) {
      if (p.type === 'tool-call' && p.toolCallId) callIds.add(p.toolCallId);
      if (p.type === 'tool-result' && p.toolCallId) resultIds.add(p.toolCallId);
    }
  }
  if (callIds.size !== resultIds.size) return false;
  for (const id of callIds) if (!resultIds.has(id)) return false;
  return true;
}

/* ── Case 1: no-op below the savings floor ───────────────────────────────── */
{
  // One superseded read worth ~BIG chars saves < MIN_SAVINGS (4000)? No — BIG is
  // 6000, over the floor. Use a small superseded read instead: 300 chars, which
  // is over DIGEST but its lone savings (~280) is below the 4000 floor → no-op.
  const head: ModelMessage[] = [
    assistantCall('c1', 'read_file', { path: 'a.ts' }),
    toolResult('c1', 'read_file', txt(300)),
    assistantCall('c2', 'read_file', { path: 'a.ts' }),
    toolResult('c2', 'read_file', txt(300)),
  ];
  const r = pruneStaleToolOutputsInHead(head);
  check('no-op below savings floor → prunedCount 0', r.prunedCount === 0);
  check('no-op below savings floor → charsSaved 0', r.charsSaved === 0);
  check('no-op leaves both outputs intact', resultOutputs(head).every((o) => !isPruned(o)));
}

/* ── Case 2: superseded read is pruned (latest survives) ─────────────────── */
{
  const head: ModelMessage[] = [
    assistantCall('c1', 'read_file', { path: 'a.ts' }),
    toolResult('c1', 'read_file', txt(BIG)), // superseded → pruned
    assistantCall('c2', 'read_file', { path: 'a.ts' }),
    toolResult('c2', 'read_file', txt(BIG)), // latest read of a.ts → kept
    // Filler reads of other files so the protect window doesn't cover c1/c2.
    assistantCall('c3', 'read_file', { path: 'b.ts' }),
    toolResult('c3', 'read_file', txt(HUGE)),
  ];
  const r = pruneStaleToolOutputsInHead(head);
  const outs = resultOutputs(head);
  check('superseded read → prunedCount 1', r.prunedCount === 1);
  check('superseded read → charsSaved > 0', r.charsSaved > 0);
  check('superseded read (c1) is pruned', isPruned(outs[0]));
  check('latest read of a.ts (c2) is NOT pruned', !isPruned(outs[1]));
  check('pairs intact after superseded-read prune', pairsIntact(head));
}

/* ── Case 3: edit invalidates an earlier read of the same file ───────────── */
{
  const head: ModelMessage[] = [
    assistantCall('c1', 'read_file', { path: 'a.ts' }),
    toolResult('c1', 'read_file', txt(BIG)), // later edited → stale → pruned
    assistantCall('e1', 'edit_file', { path: 'a.ts', oldString: 'x', newString: 'y' }),
    toolResult('e1', 'edit_file', 'edited a.ts'),
    assistantCall('c2', 'read_file', { path: 'b.ts' }),
    toolResult('c2', 'read_file', txt(HUGE)), // filler, latest of b.ts → kept
  ];
  const r = pruneStaleToolOutputsInHead(head);
  const outs = resultOutputs(head);
  check('edit-invalidates-read → prunedCount 1', r.prunedCount === 1);
  check('read of a.ts before edit is pruned', isPruned(outs[0]));
  check('edit_file result itself is NOT pruned', !isPruned(outs[1]));
  check('pairs intact after edit-invalidation prune', pairsIntact(head));
}

/* ── Case 3b: multi_edit invalidates an earlier read ─────────────────────── */
{
  const head: ModelMessage[] = [
    assistantCall('c1', 'read_file', { path: 'a.ts' }),
    toolResult('c1', 'read_file', txt(BIG)), // edited by multi_edit → stale
    assistantCall('m1', 'multi_edit', {
      edits: [
        { path: 'a.ts', oldString: 'x', newString: 'y' },
        { path: 'c.ts', oldString: 'p', newString: 'q' },
      ],
    }),
    toolResult('m1', 'multi_edit', 'edited a.ts and c.ts'),
    assistantCall('c2', 'read_file', { path: 'd.ts' }),
    toolResult('c2', 'read_file', txt(HUGE)),
  ];
  const r = pruneStaleToolOutputsInHead(head);
  check('multi_edit invalidates earlier read → prunedCount 1', r.prunedCount === 1);
  check('read invalidated by multi_edit is pruned', isPruned(resultOutputs(head)[0]));
}

/* ── Case 4: the LATEST read per path is never pruned ────────────────────── */
{
  // Three reads of a.ts; only the latest survives, the two earlier are stale.
  const head: ModelMessage[] = [
    assistantCall('c1', 'read_file', { path: 'a.ts' }),
    toolResult('c1', 'read_file', txt(BIG)),
    assistantCall('c2', 'read_file', { path: 'a.ts' }),
    toolResult('c2', 'read_file', txt(BIG)),
    assistantCall('c3', 'read_file', { path: 'a.ts' }),
    toolResult('c3', 'read_file', txt(BIG)), // latest → kept
    assistantCall('c4', 'read_file', { path: 'z.ts' }),
    toolResult('c4', 'read_file', txt(HUGE)), // filler to clear protect window
  ];
  const r = pruneStaleToolOutputsInHead(head);
  const outs = resultOutputs(head);
  check('two earlier reads pruned, latest kept → prunedCount 2', r.prunedCount === 2);
  check('latest read of a.ts (c3) is NOT pruned', !isPruned(outs[2]));
  check('earlier reads (c1,c2) pruned', isPruned(outs[0]) && isPruned(outs[1]));
}

/* ── Case 5: protect window — stale-inside IS pruned, non-stale is not ───── */
{
  // c1 (stale: superseded by c2) sits well inside the recency protect window,
  // yet must still be pruned. c2 is the latest read of a.ts and non-stale, so
  // it is protected by the window and kept.
  const head: ModelMessage[] = [
    assistantCall('c1', 'read_file', { path: 'a.ts' }),
    toolResult('c1', 'read_file', txt(BIG)), // stale + inside window → pruned
    assistantCall('c2', 'read_file', { path: 'a.ts' }),
    toolResult('c2', 'read_file', txt(BIG)), // non-stale + inside window → kept
  ];
  const r = pruneStaleToolOutputsInHead(head);
  const outs = resultOutputs(head);
  check('protect-window: stale-inside is pruned → prunedCount 1', r.prunedCount === 1);
  check('protect-window: stale c1 pruned despite recency', isPruned(outs[0]));
  check('protect-window: non-stale c2 protected (kept)', !isPruned(outs[1]));
}

/* ── Case 5b: non-stale recent read inside window is never pruned ─────────── */
{
  // A single huge, non-stale read inside the protect window stays untouched.
  const head: ModelMessage[] = [
    assistantCall('c1', 'read_file', { path: 'only.ts' }),
    toolResult('c1', 'read_file', txt(HUGE)),
  ];
  const r = pruneStaleToolOutputsInHead(head);
  check('lone non-stale read inside window → no-op', r.prunedCount === 0);
  check('lone non-stale read kept', !isPruned(resultOutputs(head)[0]));
}

/* ── Case 6: grep superseded by a later grep of the same pattern ─────────── */
{
  const head: ModelMessage[] = [
    assistantCall('g1', 'grep', { pattern: 'foo' }),
    toolResult('g1', 'grep', txt(BIG)), // superseded → pruned
    assistantCall('g2', 'grep', { pattern: 'foo' }),
    toolResult('g2', 'grep', txt(BIG)), // latest grep of "foo" → kept
    assistantCall('g3', 'grep', { pattern: 'bar' }),
    toolResult('g3', 'grep', txt(HUGE)), // different pattern → kept, clears window
  ];
  const r = pruneStaleToolOutputsInHead(head);
  const outs = resultOutputs(head);
  check('grep superseded → prunedCount 1', r.prunedCount === 1);
  check('earlier grep "foo" pruned', isPruned(outs[0]));
  check('latest grep "foo" kept', !isPruned(outs[1]));
  check('different-pattern grep kept', !isPruned(outs[2]));
}

/* ── Case 7: run_diagnostics superseded by a later run_diagnostics ───────── */
{
  // run_diagnostics has no path → both share the same target key (no-path),
  // so the earlier is superseded by the later.
  const head: ModelMessage[] = [
    assistantCall('d1', 'run_diagnostics', {}),
    toolResult('d1', 'run_diagnostics', txt(BIG)), // superseded → pruned
    assistantCall('d2', 'run_diagnostics', {}),
    toolResult('d2', 'run_diagnostics', txt(BIG)), // latest → kept
    assistantCall('c1', 'read_file', { path: 'z.ts' }),
    toolResult('c1', 'read_file', txt(HUGE)), // filler clears window
  ];
  const r = pruneStaleToolOutputsInHead(head);
  const outs = resultOutputs(head);
  check('run_diagnostics superseded → prunedCount 1', r.prunedCount === 1);
  check('earlier run_diagnostics pruned', isPruned(outs[0]));
  check('latest run_diagnostics kept', !isPruned(outs[1]));
}

/* ── Case 8: error-text result is never tracked (and never invalidates) ──── */
{
  // An errored edit mutated nothing, so the read before it stays fresh and is
  // NOT pruned. With no other supersession the pass is a no-op.
  const head: ModelMessage[] = [
    assistantCall('c1', 'read_file', { path: 'a.ts' }),
    toolResult('c1', 'read_file', txt(HUGE)),
    assistantCall('e1', 'edit_file', { path: 'a.ts', oldString: 'x', newString: 'y' }),
    toolResult('e1', 'edit_file', 'stale anchor: refused', 'error-text'),
  ];
  const r = pruneStaleToolOutputsInHead(head);
  check('error-text edit does not invalidate earlier read → no-op', r.prunedCount === 0);
  check('read before errored edit kept', !isPruned(resultOutputs(head)[0]));
}

/* ── Case 8b: an errored (error-text) read is never tracked/pruned ───────── */
{
  // An earlier errored read of a.ts is never tracked, so a later successful
  // read does not "supersede" it (there is nothing to supersede), and the
  // errored result is never pruned. Latest successful read is kept too.
  const head: ModelMessage[] = [
    assistantCall('c1', 'read_file', { path: 'a.ts' }),
    toolResult('c1', 'read_file', 'ENOENT', 'error-text'), // errored → untracked
    assistantCall('c2', 'read_file', { path: 'a.ts' }),
    toolResult('c2', 'read_file', txt(HUGE)), // latest, non-stale → kept
  ];
  const r = pruneStaleToolOutputsInHead(head);
  const outs = resultOutputs(head);
  check('errored read is never pruned/tracked → no-op', r.prunedCount === 0);
  check('errored read output left as error-text', outs[0].type === 'error-text');
  check('later successful read kept', !isPruned(outs[1]));
}

/* ── Case 9: multi-part tool message — prune individual parts, pairs hold ── */
{
  // One assistant turn fires two parallel read_file calls; one tool message
  // carries BOTH tool-results. A later read of a.ts supersedes the a.ts part
  // only — the b.ts part (latest of b.ts) must stay, proving per-PART pruning.
  const head: ModelMessage[] = [
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'p1', toolName: 'read_file', input: { path: 'a.ts' } },
        { type: 'tool-call', toolCallId: 'p2', toolName: 'read_file', input: { path: 'b.ts' } },
      ],
    },
    {
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: 'p1', toolName: 'read_file', output: { type: 'text', value: txt(BIG) } },
        { type: 'tool-result', toolCallId: 'p2', toolName: 'read_file', output: { type: 'text', value: txt(BIG) } },
      ],
    },
    // Later read of a.ts supersedes the p1 part; clears window too (HUGE).
    assistantCall('c3', 'read_file', { path: 'a.ts' }),
    toolResult('c3', 'read_file', txt(HUGE)),
  ];
  const r = pruneStaleToolOutputsInHead(head);
  const outs = resultOutputs(head); // [p1, p2, c3]
  check('multi-part: only superseded part pruned → prunedCount 1', r.prunedCount === 1);
  check('multi-part: superseded a.ts part (p1) pruned', isPruned(outs[0]));
  check('multi-part: latest b.ts part (p2) kept', !isPruned(outs[1]));
  check('multi-part: latest a.ts read (c3) kept', !isPruned(outs[2]));
  check('multi-part: every tool-call still has its tool-result', pairsIntact(head));
  // The pruned part keeps its role/toolCallId/toolName — verify the toolCallId.
  const toolMsg = head[1];
  const firstPart =
    typeof toolMsg.content !== 'string'
      ? (toolMsg.content as ReadonlyArray<{ toolCallId?: string; toolName?: string }>)[0]
      : undefined;
  check('multi-part: pruned part keeps toolCallId', firstPart?.toolCallId === 'p1');
  check('multi-part: pruned part keeps toolName', firstPart?.toolName === 'read_file');
}

/* ── Case 10: messages outside the head are not in scope (head-only) ─────── */
{
  // pruneStaleToolOutputsInHead only sees `head`; whatever the caller keeps as
  // tail is a different array it never touches. Sanity: a non-tool user/assistant
  // message in the head is left byte-identical.
  const head: ModelMessage[] = [
    { role: 'user', content: 'please read a.ts twice' },
    assistantCall('c1', 'read_file', { path: 'a.ts' }),
    toolResult('c1', 'read_file', txt(BIG)),
    assistantCall('c2', 'read_file', { path: 'a.ts' }),
    toolResult('c2', 'read_file', txt(BIG)),
    assistantCall('c3', 'read_file', { path: 'z.ts' }),
    toolResult('c3', 'read_file', txt(HUGE)),
  ];
  const before = head[0];
  pruneStaleToolOutputsInHead(head);
  check('user message in head untouched', head[0] === before && head[0].content === 'please read a.ts twice');
  check('head-only run keeps pairs intact', pairsIntact(head));
}

/* ── Case 11: fetch_url superseded by a later fetch of the SAME url ───────── */
{
  const head: ModelMessage[] = [
    assistantCall('f1', 'fetch_url', { url: 'https://example.com/a' }),
    toolResult('f1', 'fetch_url', txt(BIG)), // superseded → pruned
    assistantCall('f2', 'fetch_url', { url: 'https://example.com/a' }),
    toolResult('f2', 'fetch_url', txt(BIG)), // latest fetch of same url → kept
    assistantCall('f3', 'fetch_url', { url: 'https://example.com/z' }),
    toolResult('f3', 'fetch_url', txt(HUGE)), // different url → kept, clears window
  ];
  const r = pruneStaleToolOutputsInHead(head);
  const outs = resultOutputs(head);
  check('fetch_url same url superseded → prunedCount 1', r.prunedCount === 1);
  check('earlier fetch_url (same url) pruned', isPruned(outs[0]));
  check('latest fetch_url (same url) kept', !isPruned(outs[1]));
}

/* ── Case 11b: two fetch_url to DIFFERENT urls are both kept ──────────────── */
{
  // Neither supersedes the other (distinct urls); add a filler to clear the
  // protect window so any spurious prune would surface as a non-zero count.
  const head: ModelMessage[] = [
    assistantCall('f1', 'fetch_url', { url: 'https://example.com/a' }),
    toolResult('f1', 'fetch_url', txt(BIG)),
    assistantCall('f2', 'fetch_url', { url: 'https://example.com/b' }),
    toolResult('f2', 'fetch_url', txt(BIG)),
    assistantCall('c1', 'read_file', { path: 'z.ts' }),
    toolResult('c1', 'read_file', txt(HUGE)), // filler clears window
  ];
  const r = pruneStaleToolOutputsInHead(head);
  const outs = resultOutputs(head);
  check('fetch_url different urls → prunedCount 0', r.prunedCount === 0);
  check('fetch_url /a kept (distinct url)', !isPruned(outs[0]));
  check('fetch_url /b kept (distinct url)', !isPruned(outs[1]));
}

/* ── Case 12: web_search superseded by a later search of the same query ───── */
{
  const head: ModelMessage[] = [
    assistantCall('s1', 'web_search', { query: 'rust async' }),
    toolResult('s1', 'web_search', txt(BIG)), // superseded → pruned
    assistantCall('s2', 'web_search', { query: 'rust async' }),
    toolResult('s2', 'web_search', txt(BIG)), // latest same query → kept
    assistantCall('s3', 'web_search', { query: 'go channels' }),
    toolResult('s3', 'web_search', txt(HUGE)), // different query → kept, clears window
  ];
  const r = pruneStaleToolOutputsInHead(head);
  const outs = resultOutputs(head);
  check('web_search same query superseded → prunedCount 1', r.prunedCount === 1);
  check('earlier web_search (same query) pruned', isPruned(outs[0]));
  check('latest web_search (same query) kept', !isPruned(outs[1]));
  check('different-query web_search kept', !isPruned(outs[2]));
}

/* ── Case 12b: read_network_body superseded by a later read of same id ────── */
{
  const head: ModelMessage[] = [
    assistantCall('b1', 'read_network_body', { requestId: 'req-7' }),
    toolResult('b1', 'read_network_body', txt(BIG)), // superseded → pruned
    assistantCall('b2', 'read_network_body', { requestId: 'req-7' }),
    toolResult('b2', 'read_network_body', txt(BIG)), // latest same id → kept
    assistantCall('b3', 'read_network_body', { requestId: 'req-9' }),
    toolResult('b3', 'read_network_body', txt(HUGE)), // different id → kept, clears window
  ];
  const r = pruneStaleToolOutputsInHead(head);
  const outs = resultOutputs(head);
  check('read_network_body same id superseded → prunedCount 1', r.prunedCount === 1);
  check('earlier read_network_body (same id) pruned', isPruned(outs[0]));
  check('latest read_network_body (same id) kept', !isPruned(outs[1]));
  check('different-id read_network_body kept', !isPruned(outs[2]));
}

/* ── Case 13: an MCP tool repeated with identical input supersedes ────────── */
{
  // MCP tools are namespaced `${serverId}__${tool}`; an identical repeat is a
  // redundant lookup, so the earlier bulky payload is superseded.
  const head: ModelMessage[] = [
    assistantCall('x1', 'notion__query', { db: 'tasks', limit: 10 }),
    toolResult('x1', 'notion__query', txt(BIG)), // superseded → pruned
    assistantCall('x2', 'notion__query', { db: 'tasks', limit: 10 }),
    toolResult('x2', 'notion__query', txt(BIG)), // latest identical call → kept
    assistantCall('x3', 'notion__query', { db: 'notes', limit: 10 }),
    toolResult('x3', 'notion__query', txt(HUGE)), // different input → kept, clears window
  ];
  const r = pruneStaleToolOutputsInHead(head);
  const outs = resultOutputs(head);
  check('MCP identical input superseded → prunedCount 1', r.prunedCount === 1);
  check('earlier MCP call (identical input) pruned', isPruned(outs[0]));
  check('latest MCP call (identical input) kept', !isPruned(outs[1]));
  check('different-input MCP call kept', !isPruned(outs[2]));
}

/* ── Case 13b: MCP identical input with different KEY ORDER still supersedes ─ */
{
  // Canonical-JSON: `{db,limit}` and `{limit,db}` must hash to the same target
  // key so a key-reordered repeat still supersedes the earlier payload.
  const head: ModelMessage[] = [
    assistantCall('y1', 'plugin:acme__fetch', { db: 'tasks', limit: 10 }),
    toolResult('y1', 'plugin:acme__fetch', txt(BIG)), // superseded → pruned
    assistantCall('y2', 'plugin:acme__fetch', { limit: 10, db: 'tasks' }),
    toolResult('y2', 'plugin:acme__fetch', txt(BIG)), // same call, keys reordered → kept
    assistantCall('c1', 'read_file', { path: 'z.ts' }),
    toolResult('c1', 'read_file', txt(HUGE)), // filler clears window
  ];
  const r = pruneStaleToolOutputsInHead(head);
  const outs = resultOutputs(head);
  check('plugin reordered-key input superseded → prunedCount 1', r.prunedCount === 1);
  check('earlier plugin call (key-reordered repeat) pruned', isPruned(outs[0]));
  check('latest plugin call (key-reordered repeat) kept', !isPruned(outs[1]));
}

/* ── Case 13c: distinct MCP tools (different names) are both kept ─────────── */
{
  const head: ModelMessage[] = [
    assistantCall('z1', 'serverA__list', { q: 'x' }),
    toolResult('z1', 'serverA__list', txt(BIG)),
    assistantCall('z2', 'serverB__list', { q: 'x' }),
    toolResult('z2', 'serverB__list', txt(BIG)),
    assistantCall('c1', 'read_file', { path: 'z.ts' }),
    toolResult('c1', 'read_file', txt(HUGE)), // filler clears window
  ];
  const r = pruneStaleToolOutputsInHead(head);
  const outs = resultOutputs(head);
  check('distinct MCP tool names → prunedCount 0', r.prunedCount === 0);
  check('serverA call kept (distinct tool)', !isPruned(outs[0]));
  check('serverB call kept (distinct tool)', !isPruned(outs[1]));
}

console.log(`\n${passedCount()} checks passed`);
