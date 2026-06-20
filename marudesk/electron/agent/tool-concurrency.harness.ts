import { check, passedCount } from '../harness-kit.ts';
import { concurrencyOf, isSharedTool } from './tool-concurrency.ts';

/**
 * Harness for per-tool concurrency classification (SECOND-PASS "Per-tool
 * concurrency metadata"). Pure + dependency-light, runs under bare
 * `node --experimental-strip-types`. Asserts: read-only tools classify `shared`,
 * mutating/gated tools `exclusive`, an explicit hint can only DOWNGRADE, and
 * write/gated always force exclusive regardless of any hint.
 */

/* ── read-only tools are shared ─────────────────────────────────────────── */
for (const name of ['read_file', 'grep', 'list_files', 'read_diagnostics', 'lsp_navigate', 'lsp_symbols', 'web_search', 'fetch_url']) {
  check(`${name} classifies shared`, concurrencyOf({ name }) === 'shared' && isSharedTool({ name }));
}

/* ── mutating / gated tools are exclusive ───────────────────────────────── */
check('edit_file (write) is exclusive', concurrencyOf({ name: 'edit_file', write: true }) === 'exclusive');
check('run_command (write+gated) is exclusive', concurrencyOf({ name: 'run_command', write: true, gated: true }) === 'exclusive');
check('eval_js (gated) is exclusive', concurrencyOf({ name: 'eval_js', gated: true }) === 'exclusive');
check('an unknown tool defaults to exclusive', concurrencyOf({ name: 'some_external_tool' }) === 'exclusive');

/* ── browser reads stay exclusive (live page ordering matters) ──────────── */
check('query_dom is NOT shared (live page)', concurrencyOf({ name: 'query_dom' }) === 'exclusive');
check('screenshot is NOT shared (live page)', concurrencyOf({ name: 'screenshot', gated: true }) === 'exclusive');

/* ── explicit hint downgrades only ──────────────────────────────────────── */
check('explicit shared on a read-only tool is honored', concurrencyOf({ name: 'fetch_url', concurrency: 'shared' }) === 'shared');
check('explicit exclusive downgrades a would-be shared tool', concurrencyOf({ name: 'read_file', concurrency: 'exclusive' }) === 'exclusive');
check(
  'an explicit shared hint can NOT override a write flag',
  concurrencyOf({ name: 'read_file', write: true, concurrency: 'shared' }) === 'exclusive',
);
check(
  'an explicit shared hint can NOT override a gated flag',
  concurrencyOf({ name: 'read_file', gated: true, concurrency: 'shared' }) === 'exclusive',
);

console.log(`\ntool-concurrency harness: ${passedCount()} checks passed`);
