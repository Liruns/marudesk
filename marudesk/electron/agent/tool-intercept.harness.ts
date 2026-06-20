import { check, passedCount } from '../harness-kit.ts';
import {
  registerBeforeToolCall,
  registerAfterToolCall,
  runBeforeToolCall,
  runAfterToolCall,
  __clearToolInterceptRegistries,
  type ToolCallMeta,
  type ToolCallResult,
} from './tool-intercept.ts';

/**
 * Harness for the per-tool-call intercept seam (SECOND-PASS "Per-tool-call
 * intercept seam"). Pure + dependency-free, so it runs standalone under bare
 * `node --experimental-strip-types`. Covers: empty registry is a passthrough
 * (no block, result unchanged); a before-hook blocks with a reason; the first
 * block wins; an after-hook rewrites/annotates and chains; throwing hooks are
 * non-fatal; unregister removes a hook; priority ordering.
 */

const META: ToolCallMeta = {
  name: 'read_file',
  input: { path: 'a.ts' },
  ws: '/tmp/ws',
  provider: 'anthropic',
  modelId: 'claude-test',
};
const RESULT: ToolCallResult = { summary: 'read a.ts', text: 'contents' };

/* ── empty registry = passthrough ───────────────────────────────────────── */
{
  __clearToolInterceptRegistries();
  const block = await runBeforeToolCall(META);
  check('empty before registry returns null (no block)', block === null);
  const out = await runAfterToolCall(META, RESULT);
  check('empty after registry returns the result unchanged', out.summary === 'read a.ts' && out.text === 'contents' && out.isError === undefined);
}

/* ── before-hook blocks with a reason ───────────────────────────────────── */
{
  __clearToolInterceptRegistries();
  const off = registerBeforeToolCall('normal', () => ({ reason: 'denied by policy' }));
  const block = await runBeforeToolCall(META);
  check('before-hook can block with a reason', block?.reason === 'denied by policy');
  off();
  check('after unregister the block is gone', (await runBeforeToolCall(META)) === null);
}

/* ── empty/whitespace reason is not a block ─────────────────────────────── */
{
  __clearToolInterceptRegistries();
  const off = registerBeforeToolCall('normal', () => ({ reason: '   ' }));
  check('a whitespace-only reason is treated as no block', (await runBeforeToolCall(META)) === null);
  off();
}

/* ── first block wins, in priority order ────────────────────────────────── */
{
  __clearToolInterceptRegistries();
  const offLow = registerBeforeToolCall('low', () => ({ reason: 'low' }));
  const offHigh = registerBeforeToolCall('high', () => ({ reason: 'high' }));
  const block = await runBeforeToolCall(META);
  check('higher-priority block wins', block?.reason === 'high');
  offLow();
  offHigh();
}

/* ── a throwing before-hook is skipped (allow) ──────────────────────────── */
{
  __clearToolInterceptRegistries();
  const offThrow = registerBeforeToolCall('high', () => {
    throw new Error('boom');
  });
  const offBlock = registerBeforeToolCall('low', () => ({ reason: 'survived' }));
  const block = await runBeforeToolCall(META);
  check('a throwing before-hook is non-fatal; later hooks still run', block?.reason === 'survived');
  offThrow();
  offBlock();
}

/* ── after-hook rewrites + chains ───────────────────────────────────────── */
{
  __clearToolInterceptRegistries();
  const off1 = registerAfterToolCall('high', (_m, r) => ({ summary: r.summary, text: `${r.text} [a]` }));
  const off2 = registerAfterToolCall('low', (_m, r) => ({ summary: r.summary, text: `${r.text} [b]` }));
  const out = await runAfterToolCall(META, RESULT);
  check('after-hooks chain in priority order', out.text === 'contents [a] [b]');
  off1();
  off2();
}

/* ── after-hook null leaves result unchanged; isError preserved ─────────── */
{
  __clearToolInterceptRegistries();
  const off = registerAfterToolCall('normal', () => null);
  const errResult: ToolCallResult = { summary: 's', text: 't', isError: true };
  const out = await runAfterToolCall(META, errResult);
  check('after-hook returning null leaves the result unchanged', out.text === 't' && out.isError === true);
  off();
}

/* ── a throwing after-hook is skipped, chain continues ──────────────────── */
{
  __clearToolInterceptRegistries();
  const offThrow = registerAfterToolCall('high', () => {
    throw new Error('boom');
  });
  const offOk = registerAfterToolCall('low', (_m, r) => ({ summary: r.summary, text: `${r.text}!` }));
  const out = await runAfterToolCall(META, RESULT);
  check('a throwing after-hook is non-fatal; the chain continues', out.text === 'contents!');
  offThrow();
  offOk();
}

__clearToolInterceptRegistries();
console.log(`\ntool-intercept harness: ${passedCount()} checks passed`);
