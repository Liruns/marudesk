import type { ModelMessage } from 'ai';

/**
 * Pure transcript helpers for `/compact` (claude-code / codex parity), split out
 * of loop.ts so the stateful compaction flow there reads as orchestration. None
 * of these touch module state — they map a `ModelMessage[]` to text, a char
 * weight, or a head/tail split.
 */

/**
 * Per-tool-result excerpt budget for the summarization prompt. The compaction
 * instruction asks the model to keep "error signatures verbatim" — it can only
 * do that if the serialized trace actually carries a slice of each result, not
 * just the tool's name. Small enough that a long tool-heavy head stays bounded.
 */
const TOOL_RESULT_EXCERPT_CHARS = 300;

/** A clipped, whitespace-collapsed slice of one tool result's textual output. */
function toolResultExcerpt(output: unknown): string {
  if (!output || typeof output !== 'object') return '';
  const o = output as { type?: unknown; value?: unknown };
  let text = '';
  if (typeof o.value === 'string') {
    text = o.value;
  } else if (Array.isArray(o.value)) {
    // Multipart ('content') output: keep the text items, skip inline images.
    text = o.value
      .map((item) =>
        item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
          ? (item as { text: string }).text
          : '',
      )
      .filter(Boolean)
      .join(' ');
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const clipped =
    text.length <= TOOL_RESULT_EXCERPT_CHARS ? text : `${text.slice(0, TOOL_RESULT_EXCERPT_CHARS)}…`;
  return o.type === 'error-text' ? `ERROR: ${clipped}` : clipped;
}

/** Flatten the running transcript to plain text for the summarization prompt. */
export function serializeForCompaction(msgs: ModelMessage[]): string {
  const lines: string[] = [];
  for (const m of msgs) {
    let text: string;
    if (typeof m.content === 'string') {
      text = m.content;
    } else {
      // Each part is one of the AI SDK content shapes; we only need a textual
      // trace (prose + which tools ran and what they returned), so read just
      // these fields structurally.
      const parts = m.content as ReadonlyArray<{
        type: string;
        text?: string;
        toolName?: string;
        output?: unknown;
      }>;
      const pieces: string[] = [];
      for (const p of parts) {
        if (p.type === 'text' && p.text) pieces.push(p.text);
        else if (p.type === 'tool-call' && p.toolName) pieces.push(`[ran ${p.toolName}]`);
        else if (p.type === 'tool-result' && p.toolName) {
          const excerpt = toolResultExcerpt(p.output);
          pieces.push(excerpt ? `[result of ${p.toolName}] ${excerpt}` : `[result of ${p.toolName}]`);
        } else if (p.type === 'image') pieces.push('[image]');
      }
      text = pieces.join(' ');
    }
    text = text.trim();
    if (text) lines.push(`${m.role}: ${text}`);
  }
  return lines.join('\n\n');
}

/**
 * Emergency compaction floor — an unconditional backstop against unbounded
 * transcript growth, independent of the token-ratio path in `shouldAutoCompact`.
 * It fires even when auto-compact is disabled or the model's context window is
 * unknown (unlisted / custom / openai-compat providers), where the ratio path
 * can't compute a threshold and would otherwise let the transcript grow forever.
 *
 * Both ceilings are intentionally high: for known models the token-ratio path
 * (e.g. 80% of the context window) trips long before either of these, so the
 * floor stays a backstop rather than the primary trigger and avoids false
 * positives. `EMERGENCY_TRANSCRIPT_CHARS` is sized off a ~4 bytes/token
 * heuristic, so 4M chars is roughly a million tokens — far past any normal
 * model's window.
 */
export const EMERGENCY_MESSAGE_COUNT = 500;
export const EMERGENCY_TRANSCRIPT_CHARS = 4_000_000;

/**
 * Which emergency floor (if any) the transcript has crossed. Pure — no process,
 * Electron, or module state — so it's testable in a bare harness. `messageCount`
 * takes precedence when both ceilings are exceeded.
 */
export function emergencyCompactionReason(
  transcriptLength: number,
  transcriptChars: number,
): 'messageCount' | 'transcriptChars' | null {
  if (transcriptLength > EMERGENCY_MESSAGE_COUNT) return 'messageCount';
  if (transcriptChars > EMERGENCY_TRANSCRIPT_CHARS) return 'transcriptChars';
  return null;
}

/** Rough character weight of one message (proxy for token size). */
export function messageChars(m: ModelMessage): number {
  if (typeof m.content === 'string') return m.content.length;
  let n = 0;
  for (const p of m.content as ReadonlyArray<{ text?: string; output?: { value?: string }; input?: unknown }>) {
    if (typeof p.text === 'string') n += p.text.length;
    if (typeof p.output?.value === 'string') n += p.output.value.length;
    if (p.input !== undefined) n += JSON.stringify(p.input).length;
  }
  return n;
}

/**
 * Staleness-aware tool-output pruning (COMPACT-1). Before the older `head` of a
 * transcript is summarized, replace the bulky `output.value` of tool results
 * that have been *superseded* — a later read of the same file, a later grep of
 * the same pattern, a later diagnostics run, or a read whose file was edited
 * afterward — with a short notice. This drops dead payload from the
 * summarization prompt without touching edits, user text, or the verbatim tail.
 *
 * Ported from gajae's `buildStalenessIndex`/`pruneToolOutputs`
 * (packages/agent/src/compaction/pruning.ts), re-expressed for marudesk's
 * `ModelMessage[]` shape: the reference walks a flat `SessionEntry[]` with
 * single-result entries; here a `role:'tool'` message can hold several
 * `tool-result` parts (parallel calls), so the index is keyed per individual
 * part — never per whole message — to keep every assistant `tool-call` paired
 * with its `tool-result`.
 */

/** Protect roughly this many chars of the most-recent head from pruning (unless stale). */
const PRUNE_PROTECT_CHARS = 8000;
/** Hysteresis: skip the whole pass if total savings would be below this. */
const PRUNE_MIN_SAVINGS_CHARS = 4000;
/** Outputs already this short are never worth pruning. */
const PRUNE_DIGEST_CHARS = 120;

/** Tool results whose textual output is eligible for pruning when superseded. */
const PRUNABLE_TOOL_NAMES: ReadonlySet<string> = new Set(['read_file', 'grep', 'run_diagnostics']);
/** Tools whose calls mark a file as edited (invalidating earlier reads of it). */
const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set(['edit_file', 'multi_edit']);

/** Minimal structural views of the AI SDK content parts we read here. */
type ToolCallPart = { type: 'tool-call'; toolCallId: string; toolName: string; input?: unknown };
type ToolResultOutput = { type: string; value?: unknown };
type ToolResultPart = {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output: ToolResultOutput;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Length of a tool result's textual `output.value` (the prunable payload). */
function outputValueChars(output: ToolResultOutput): number {
  return typeof output.value === 'string' ? output.value.length : 0;
}

/**
 * A one-line digest of a tool result kept in place of its pruned payload, so the
 * model still sees the *signal* (an exit code, a match count, an error tally)
 * and doesn't re-run the command to recover it (gajae `compaction/pruning.ts`).
 * Pure string heuristics over the result text — no parsing of structured fields,
 * which the AI SDK tool-result shape doesn't carry here. Returns '' when nothing
 * useful can be salvaged (the caller then falls back to the bare freed-chars
 * notice). `value` is the raw textual output; `toolName` selects the heuristic.
 */
function pruneDigest(toolName: string, value: string): string {
  const lines = value.split('\n');
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (toolName === 'run_diagnostics') {
    // run_diagnostics returns file:line errors; surface the error count + first.
    const errorLines = nonEmpty.filter((l) => /\b(error|TS\d{3,}|E\d{2,})\b/i.test(l));
    if (errorLines.length > 0) {
      return `${errorLines.length} diagnostic(s); first: ${errorLines[0].trim().slice(0, 160)}`;
    }
    return nonEmpty.length > 0 ? 'no diagnostics reported' : '';
  }
  if (toolName === 'grep') {
    // grep results are one match per line (often "path:line: …"); count matches
    // and distinct files (the leading path segment before the first colon).
    const files = new Set<string>();
    for (const l of nonEmpty) {
      const m = /^([^:]+):/.exec(l.trim());
      if (m) files.add(m[1]);
    }
    const fileNote = files.size > 0 ? ` across ${files.size} file(s)` : '';
    return `${nonEmpty.length} match line(s)${fileNote}`;
  }
  if (toolName === 'read_file') {
    return `${lines.length} line(s) read`;
  }
  return '';
}

/**
 * The replacement notice written over a pruned tool result's output. Keeps a
 * tool-specific micro-summary (item 5) when one can be salvaged so the model
 * retains the signal; always records the freed chars. Pure.
 */
function prunedNotice(toolName: string, value: string, chars: number): string {
  const digest = typeof value === 'string' ? pruneDigest(toolName, value) : '';
  return digest
    ? `[output pruned — ~${chars} chars freed; ${digest}]`
    : `[output pruned — ~${chars} chars freed]`;
}

/**
 * Stable identity for "the same logical lookup" so a later result supersedes
 * earlier ones: `read_file` keys on its path, `grep` on its pattern. Canonical
 * JSON tuples so user text can't collide via delimiter ambiguity. Returns
 * undefined for tools we don't supersede by target.
 */
function toolTargetKey(toolName: string, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  if (toolName === 'read_file') {
    const path = input.path;
    return typeof path === 'string' && path.length > 0
      ? JSON.stringify(['read_file', 'path', path])
      : undefined;
  }
  if (toolName === 'grep') {
    const pattern = input.pattern;
    return typeof pattern === 'string' && pattern.length > 0
      ? JSON.stringify(['grep', 'pattern', pattern])
      : undefined;
  }
  if (toolName === 'run_diagnostics') {
    // `path` is optional (whole-workspace when absent). Same-scope diagnostics
    // runs supersede each other; '' is the canonical "no path" scope.
    const path = input.path;
    const scope = typeof path === 'string' && path.length > 0 ? path : '';
    return JSON.stringify(['run_diagnostics', 'path', scope]);
  }
  return undefined;
}

/** Workspace-relative path of a `read_file` call, if present. */
function readCallPath(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const path = input.path;
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

/** Files an edit call touches: `edit_file.path` or each `multi_edit.edits[].path`. */
function editCallPaths(toolName: string, input: unknown): string[] {
  if (!isRecord(input)) return [];
  if (toolName === 'edit_file') {
    const path = input.path;
    return typeof path === 'string' && path.length > 0 ? [path] : [];
  }
  if (toolName === 'multi_edit') {
    const edits = input.edits;
    if (!Array.isArray(edits)) return [];
    const out: string[] = [];
    for (const e of edits) {
      if (isRecord(e) && typeof e.path === 'string' && e.path.length > 0) out.push(e.path);
    }
    return out;
  }
  return [];
}

/**
 * In place, replace the bulky text output of stale tool results in `head` with a
 * short pruned notice, returning `{ prunedCount, charsSaved }`. Pure (no fs /
 * Electron). Pairing invariant: only a result part's `output` *value* is
 * replaced — never a message or part removed — so every assistant `tool-call`
 * keeps its paired `tool-result`. No-op (returns zeros) when the total savings
 * would fall below {@link PRUNE_MIN_SAVINGS_CHARS}.
 */
export function pruneStaleToolOutputsInHead(
  head: ModelMessage[],
): { prunedCount: number; charsSaved: number } {
  // Pass 1: collect assistant tool-call parts (callId -> tool name + input).
  const callsByCallId = new Map<string, { toolName: string; input: unknown }>();
  for (const m of head) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const p of m.content as ReadonlyArray<{ type: string }>) {
      if (p.type !== 'tool-call') continue;
      const call = p as ToolCallPart;
      callsByCallId.set(call.toolCallId, { toolName: call.toolName, input: call.input });
    }
  }

  // A flat, append-ordered list of every tool-result part with its location, so
  // "later" means a higher flat index regardless of message/part nesting.
  type ResultRef = {
    msgIdx: number;
    partIdx: number;
    part: ToolResultPart;
    toolName: string;
    input: unknown;
  };
  const results: ResultRef[] = [];
  const lastResultIdxByKey = new Map<string, number>();
  const lastEditIdxByPath = new Map<string, number>();

  // Pass 2: walk tool-result parts oldest -> newest, recording edits and the
  // most-recent result per target. error-text results are never tracked
  // (an errored edit mutated nothing; an errored read is not authoritative).
  for (let mi = 0; mi < head.length; mi++) {
    const m = head[mi];
    if (m.role !== 'tool' || typeof m.content === 'string') continue;
    const parts = m.content as ReadonlyArray<{ type: string }>;
    for (let pi = 0; pi < parts.length; pi++) {
      const raw = parts[pi];
      if (raw.type !== 'tool-result') continue;
      const part = raw as ToolResultPart;
      const call = callsByCallId.get(part.toolCallId);
      if (!call) continue;
      if (part.output.type === 'error-text') continue;

      const flatIdx = results.length;
      results.push({ msgIdx: mi, partIdx: pi, part, toolName: call.toolName, input: call.input });

      const key = toolTargetKey(call.toolName, call.input);
      if (key !== undefined) lastResultIdxByKey.set(key, flatIdx);
      if (EDIT_TOOL_NAMES.has(call.toolName)) {
        for (const editPath of editCallPaths(call.toolName, call.input)) {
          lastEditIdxByPath.set(editPath, flatIdx);
        }
      }
    }
  }

  // Mark a result STALE when a later result supersedes the same target, OR a
  // read_file's file was edited after it. The most-recent result per target is
  // never stale; the latest read of each file stays protected.
  const stale = new Set<number>();
  for (let idx = 0; idx < results.length; idx++) {
    const r = results[idx];
    const key = toolTargetKey(r.toolName, r.input);
    if (key !== undefined) {
      const last = lastResultIdxByKey.get(key);
      if (last !== undefined && last > idx) {
        stale.add(idx);
        continue;
      }
    }
    if (r.toolName === 'read_file') {
      const path = readCallPath(r.input);
      if (path !== undefined) {
        const editIdx = lastEditIdxByPath.get(path);
        if (editIdx !== undefined && editIdx > idx) stale.add(idx);
      }
    }
  }

  // Prune pass: newest -> oldest, tracking accumulated chars. Mirrors the
  // reference's two-layer guard. A prunable tool's output is protected (immune)
  // UNLESS it is stale — so the latest read of each file (never stale) is always
  // kept, while a superseded/edit-invalidated read is prunable even inside the
  // recency protect window. The window itself only skips NON-stale results; for
  // our prunable set (read_file/grep/run_diagnostics) tool-immunity already
  // covers the non-stale case, so in practice only stale outputs are pruned.
  type Candidate = { ref: ResultRef; savings: number; notice: string };
  const candidates: Candidate[] = [];
  let accChars = 0;
  for (let idx = results.length - 1; idx >= 0; idx--) {
    const r = results[idx];
    const chars = outputValueChars(r.part.output);
    const isStale = stale.has(idx);
    const insideProtectWindow = accChars < PRUNE_PROTECT_CHARS;
    accChars += chars;

    if (!PRUNABLE_TOOL_NAMES.has(r.toolName)) continue;
    if (chars <= PRUNE_DIGEST_CHARS) continue;
    // Tool-immunity: a prunable tool is protected unless it is stale (the latest
    // result per target stays protected). Plus the recency window for non-stale.
    const isProtected = !isStale;
    if (isProtected || (insideProtectWindow && !isStale)) continue;

    const value = typeof r.part.output.value === 'string' ? r.part.output.value : '';
    const notice = prunedNotice(r.toolName, value, chars);
    const savings = chars - notice.length;
    if (savings <= 0) continue;
    candidates.push({ ref: r, savings, notice });
  }

  // Hysteresis: if the whole pass wouldn't save enough, do nothing at all.
  const totalSavings = candidates.reduce((n, c) => n + c.savings, 0);
  if (candidates.length === 0 || totalSavings < PRUNE_MIN_SAVINGS_CHARS) {
    return { prunedCount: 0, charsSaved: 0 };
  }

  let charsSaved = 0;
  for (const c of candidates) {
    // Preserve role / toolCallId / toolName (pair integrity) — replace the
    // output VALUE only, keeping a tool-specific micro-summary when available.
    c.ref.part.output = { type: 'text', value: c.notice };
    charsSaved += c.savings;
  }
  return { prunedCount: candidates.length, charsSaved };
}

/**
 * Split a transcript into the older `head` (to be summarized) and a verbatim
 * `tail` of the most recent turns. The tail is the smallest set of whole turns
 * whose character weight is at least `tailFraction` of the total, snapped to a
 * `user`-message boundary so the rebuilt transcript stays valid (alternation +
 * Anthropic's first-message-is-user rule). Falls back to an empty tail when the
 * split would leave nothing to summarize.
 */
export function splitForTailPreservation(
  msgs: ModelMessage[],
  tailFraction: number,
): { head: ModelMessage[]; tail: ModelMessage[] } {
  const total = msgs.reduce((n, m) => n + messageChars(m), 0);
  const budget = total * tailFraction;
  let acc = 0;
  let splitIdx = -1;
  for (let i = msgs.length - 1; i > 0; i--) {
    acc += messageChars(msgs[i]);
    if (msgs[i].role === 'user' && acc >= budget) {
      splitIdx = i;
      break;
    }
  }
  if (splitIdx <= 0) return { head: msgs, tail: [] };
  return { head: msgs.slice(0, splitIdx), tail: msgs.slice(splitIdx) };
}

/* ── File-operation manifest (item 4 / gajae compaction/utils.ts) ─────────── */

/** Files the summarized head read (read-only) vs. modified (edit_file/multi_edit). */
export type FileManifest = { readFiles: string[]; modifiedFiles: string[] };

/** Cap each manifest list so a survey-heavy head can't bloat the summary. */
const FILE_MANIFEST_LIMIT = 30;

function clampFileList(files: string[]): string[] {
  if (files.length <= FILE_MANIFEST_LIMIT) return files;
  const omitted = files.length - FILE_MANIFEST_LIMIT;
  return [...files.slice(0, FILE_MANIFEST_LIMIT), `… (${omitted} more)`];
}

/**
 * Derive the {@link FileManifest} from a transcript's assistant tool-calls — the
 * same scan {@link pruneStaleToolOutputsInHead} already does, expressed once here
 * for the compaction summary. A file that was edited counts only as modified
 * (even if also read first), so the two lists are disjoint. Pure; reads only
 * `read_file` / `edit_file` / `multi_edit` call inputs.
 */
export function extractFileManifest(msgs: ModelMessage[]): FileManifest {
  const read = new Set<string>();
  const modified = new Set<string>();
  for (const m of msgs) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const raw of m.content as ReadonlyArray<{ type: string }>) {
      if (raw.type !== 'tool-call') continue;
      const call = raw as ToolCallPart;
      if (call.toolName === 'read_file') {
        const path = readCallPath(call.input);
        if (path) read.add(path);
      } else if (EDIT_TOOL_NAMES.has(call.toolName)) {
        for (const path of editCallPaths(call.toolName, call.input)) modified.add(path);
      }
    }
  }
  const readOnly = [...read].filter((f) => !modified.has(f)).sort();
  return { readFiles: clampFileList(readOnly), modifiedFiles: clampFileList([...modified].sort()) };
}

/**
 * Strip any `<read-files>` / `<modified-files>` blocks a previous compaction
 * appended, so a merge pass doesn't carry stale manifest tags inside the prose
 * (a fresh manifest is re-appended by the caller). Pure.
 */
export function stripFileManifest(summary: string): string {
  return summary
    .replace(/<read-files>[\s\S]*?<\/read-files>\s*/g, '')
    .replace(/<modified-files>[\s\S]*?<\/modified-files>\s*/g, '')
    .trimEnd();
}

/**
 * Render the manifest as machine-readable `<read-files>` / `<modified-files>`
 * blocks appended to a compaction summary, so the resumed model immediately
 * knows the scope it was working in. Returns '' when nothing was touched.
 */
export function formatFileManifest(manifest: FileManifest): string {
  const { readFiles, modifiedFiles } = manifest;
  if (readFiles.length === 0 && modifiedFiles.length === 0) return '';
  const blocks: string[] = [];
  if (readFiles.length > 0) {
    blocks.push(`<read-files>\n${readFiles.map((f) => `- ${f}`).join('\n')}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    blocks.push(
      `<modified-files>\n${modifiedFiles.map((f) => `- ${f}`).join('\n')}\n</modified-files>`,
    );
  }
  return blocks.join('\n');
}

/* ── Per-tool output cap (item 7 / omo tool-output-truncator) ─────────────── */

/**
 * Tools whose textual result is NEVER capped (item 7). The policy is
 * default-cap: ANY tool result is bounded by {@link capToolOutput} *unless* its
 * name is exempted here, so a high-volume MCP / plugin / `read_*` result can no
 * longer silently eat tens of thousands of tokens and force a needless
 * compaction. Two exemption classes:
 *
 *  - `read_file`: its output is anchor-bearing and the model edits against it,
 *    so it must reach the model intact (the read-tracker keeps the
 *    authoritative snapshot regardless).
 *  - Control tools (`ask_user` / `update_plan` / `spawn_*`): they return tiny
 *    control payloads, not bulk content, so capping them is pointless and risks
 *    clipping a structured signal the loop depends on.
 */
export const UNCAPPED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_file',
  'ask_user',
  'update_plan',
  'spawn_background_agent',
  'spawn_subagent',
]);

/** ~4 chars/token; the default cap (~50k tokens) and a tighter cap for web fetches. */
const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_OUTPUT_TOKENS = 50_000;
const FETCH_MAX_OUTPUT_TOKENS = 10_000;
/** Tools that warrant the tighter cap (whole web pages). */
const TIGHT_CAP_TOOLS: ReadonlySet<string> = new Set(['fetch_url', 'web_search']);

/**
 * Cap a tool result's DISPLAYED text to a char budget derived from the model's
 * context window (item 7), keeping the head and appending a clear truncation
 * footer so the model knows output was elided (and can narrow its query). Pure:
 * returns `{ text, truncated }`; never mutates anchors or any tracker — the
 * caller applies it to the model-facing result string only. `contextWindow` is
 * the active model's window (0/undefined ⇒ use the default budget). The per-tool
 * cap is the smaller of the tool's ceiling and ~⅓ of the window, so one result
 * can't dominate the context. Default-cap: applies to ANY tool except the
 * {@link UNCAPPED_TOOL_NAMES} exemptions (anchor-bearing reads + tiny control
 * payloads).
 */
export function capToolOutput(
  toolName: string,
  text: string,
  contextWindow: number | undefined,
): { text: string; truncated: boolean } {
  if (UNCAPPED_TOOL_NAMES.has(toolName)) return { text, truncated: false };
  const toolCeilingTokens = TIGHT_CAP_TOOLS.has(toolName)
    ? FETCH_MAX_OUTPUT_TOKENS
    : DEFAULT_MAX_OUTPUT_TOKENS;
  // Context-window aware: never let a single tool result exceed ~⅓ of the window.
  const windowTokens = contextWindow && contextWindow > 0 ? Math.floor(contextWindow / 3) : Infinity;
  const maxTokens = Math.min(toolCeilingTokens, windowTokens);
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return { text, truncated: false };
  const droppedChars = text.length - maxChars;
  const footer = `\n\n[output truncated — ${droppedChars} of ${text.length} chars elided to bound context; narrow your query (e.g. a more specific pattern/path) to see more]`;
  return { text: `${text.slice(0, maxChars)}${footer}`, truncated: true };
}

/* ── Post-compaction degradation monitor (item 3 / omo) ───────────────────── */

/** How many assistant responses after a compaction the degradation monitor watches. */
export const POST_COMPACTION_MONITOR_COUNT = 5;
/** Consecutive no-text responses within the window that flag a too-lossy summary. */
export const POST_COMPACTION_NO_TEXT_THRESHOLD = 3;

/** A monitor's running state, advanced one response at a time. Pure value type. */
export type DegradationState = {
  /** Responses still left in the monitor window (0 ⇒ monitor inert). */
  monitorRemaining: number;
  /** Consecutive no-text responses seen so far in this window. */
  emptyStreak: number;
};

/**
 * Advance the post-compaction degradation monitor by one assistant response
 * (item 3). `hasVisibleText` is whether the response carried any prose (a
 * tool-only / empty response is the degradation signal). Pure: returns the next
 * state plus whether THIS response just crossed the no-text threshold (the
 * caller then injects a corrective note / re-compacts, once). When the window is
 * already closed (`monitorRemaining <= 0`) the state is returned unchanged and
 * `degraded` is false, so a healthy long tool-only stretch never trips it.
 */
export function advanceDegradationMonitor(
  state: DegradationState,
  hasVisibleText: boolean,
): { state: DegradationState; degraded: boolean } {
  if (state.monitorRemaining <= 0) return { state, degraded: false };
  const monitorRemaining = state.monitorRemaining - 1;
  if (hasVisibleText) {
    return { state: { monitorRemaining, emptyStreak: 0 }, degraded: false };
  }
  const emptyStreak = state.emptyStreak + 1;
  const degraded = emptyStreak >= POST_COMPACTION_NO_TEXT_THRESHOLD;
  return { state: { monitorRemaining, emptyStreak }, degraded };
}

/* ── Tool-pair orphan recovery (item 1 / omo tool-pair-validator) ─────────── */

/** Minimal view of an assistant tool-call id within a transcript. */
type AnyPart = { type?: unknown; toolCallId?: unknown; toolName?: unknown };

function partToolCallId(p: AnyPart): string | undefined {
  return typeof p.toolCallId === 'string' && p.toolCallId.length > 0 ? p.toolCallId : undefined;
}

/**
 * Repair tool-call ↔ tool-result pairing across a (re)built transcript so the
 * NEXT provider API call can't 400 on an orphan. Two orphan classes the
 * compaction boundary can leave:
 *
 *  1. An assistant `tool-call` whose paired `tool-result` was dropped (its
 *     result lived in the summarized head). We inject a synthetic placeholder
 *     `tool-result` right after the assistant message so every `tool_use` is
 *     answered (Anthropic hard-requires this).
 *  2. A `tool-result` whose paired `tool-call` was dropped (the call lived in
 *     the head). A result with no preceding call is meaningless and itself a
 *     400 trigger, so we drop the orphaned result part (and any now-empty tool
 *     message).
 *
 * Returns a NEW array (input untouched) plus counts. Pure — no Electron/fs.
 * Order is preserved; the verbatim tail's user/assistant text is never altered.
 */
export function repairToolPairs(
  msgs: ModelMessage[],
): { messages: ModelMessage[]; injectedResults: number; droppedResults: number } {
  // Pass 1: every tool-call id that has a matching tool-result somewhere later.
  const resultIds = new Set<string>();
  for (const m of msgs) {
    if (m.role !== 'tool' || typeof m.content === 'string') continue;
    for (const p of m.content as ReadonlyArray<AnyPart>) {
      if (p.type === 'tool-result') {
        const id = partToolCallId(p);
        if (id) resultIds.add(id);
      }
    }
  }

  let injectedResults = 0;
  let droppedResults = 0;
  const out: ModelMessage[] = [];
  // Call ids seen so far, in transcript order — a tool-result is an orphan
  // (class 2) only when no preceding assistant message issued its call.
  const knownCallIds = new Set<string>();

  for (const m of msgs) {
    // Drop orphaned tool-result PARTS (class 2): a result whose call is absent
    // from THIS transcript. We rebuild call presence on the fly from the
    // assistant messages already emitted to `out` plus this scan's call set.
    if (m.role === 'tool' && typeof m.content !== 'string') {
      const parts = m.content as ReadonlyArray<AnyPart>;
      const kept = parts.filter((p) => {
        if (p.type !== 'tool-result') return true;
        const id = partToolCallId(p);
        if (id && knownCallIds.has(id)) return true;
        droppedResults += 1;
        return false;
      });
      // An entirely-orphaned tool message is dropped; otherwise keep the
      // surviving parts (pairs for present calls stay intact). `kept` is a
      // subset of this tool message's own (already valid) ToolContent parts.
      if (kept.length === parts.length) {
        out.push(m);
      } else if (kept.length > 0) {
        out.push({ role: 'tool', content: kept as typeof m.content });
      }
      continue;
    }

    out.push(m);

    // After an assistant message, inject placeholders for any of its tool-calls
    // that never get a result anywhere in the transcript (class 1).
    if (m.role === 'assistant' && typeof m.content !== 'string') {
      const missing: { toolCallId: string; toolName: string }[] = [];
      for (const p of m.content as ReadonlyArray<AnyPart>) {
        if (p.type !== 'tool-call') continue;
        const id = partToolCallId(p);
        if (!id) continue;
        knownCallIds.add(id);
        if (!resultIds.has(id)) {
          const toolName = typeof p.toolName === 'string' ? p.toolName : 'unknown';
          missing.push({ toolCallId: id, toolName });
        }
      }
      if (missing.length > 0) {
        const placeholders = missing.map((mm) => ({
          type: 'tool-result' as const,
          toolCallId: mm.toolCallId,
          toolName: mm.toolName,
          output: { type: 'text' as const, value: '[result omitted by compaction]' },
        }));
        out.push({ role: 'tool', content: placeholders });
        injectedResults += missing.length;
      }
    }
  }

  return { messages: out, injectedResults, droppedResults };
}
