/**
 * Per-tool concurrency classification (SECOND-PASS "Per-tool concurrency
 * metadata"). The dispatch loop runs tool calls serially by default; a tool
 * declared `shared` (read-only, no side effects) may instead run concurrently
 * with its `shared` neighbors in the same model turn, turning a 5-grep + 3-read
 * survey from a SUM of latencies into a MAX.
 *
 * The classification is conservative and DERIVED, not free-form: a tool is
 * `shared` only when it is on the explicit read-only allowlist below AND carries
 * no `write`/`gated` flag. Everything else is `exclusive` (the safe default), so
 * a misclassification can only ever make a tool MORE serial, never wrongly
 * parallelize a mutation. An explicit `concurrency` field on the descriptor wins
 * (a tool — or a future external/plugin tool — can opt out), but is only honored
 * to DOWNGRADE to `exclusive`: a tool that also sets `write`/`gated` can never be
 * forced `shared`.
 *
 * Pure + dependency-free (no Electron imports) so it loads under the plain
 * `--experimental-strip-types` harness; relative value imports use explicit `.ts`.
 */
import type { McpToolDef, ToolConcurrency } from './tools/types.ts';

/**
 * Built-in tools that are pure reads with no workspace/app/page side effects and
 * whose ordering relative to siblings is irrelevant — safe to run in parallel.
 * Deliberately tight: only the file/code readers. NOT included (stay exclusive):
 *  - edit_file/multi_edit/lsp_rename/run_command (mutate the workspace),
 *  - eval_js/click/fill/press_key/scroll/reload_and_verify (mutate the page),
 *  - run_diagnostics (gated; may run the project's own checks),
 *  - browser reads (query_dom/read_network/screenshot/…): they observe a LIVE,
 *    mutating page where another call in the same batch could change state, so
 *    their ordering matters — kept serial out of caution.
 */
const SHARED_READONLY_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_files',
  'grep',
  'read_diagnostics',
  'lsp_navigate',
  'lsp_symbols',
  'web_search',
  'fetch_url',
]);

/**
 * Classify a tool descriptor's scheduling concurrency. Honors an explicit
 * `concurrency` field (only to downgrade), otherwise derives from the read-only
 * allowlist gated by the absence of write/gated. Defaults to `exclusive`.
 */
export function concurrencyOf(def: Pick<McpToolDef, 'name' | 'write' | 'gated' | 'concurrency'>): ToolConcurrency {
  // A mutating or gated tool is ALWAYS exclusive, regardless of any hint.
  if (def.write === true || def.gated === true) return 'exclusive';
  if (def.concurrency === 'exclusive') return 'exclusive';
  if (def.concurrency === 'shared') return 'shared';
  return SHARED_READONLY_TOOLS.has(def.name) ? 'shared' : 'exclusive';
}

/** Convenience predicate used by the dispatch loop. */
export function isSharedTool(def: Pick<McpToolDef, 'name' | 'write' | 'gated' | 'concurrency'>): boolean {
  return concurrencyOf(def) === 'shared';
}
