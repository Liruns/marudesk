import { check, passedCount } from '../harness-kit.ts';
import { aiTools, cachedSystem, withMessagePrefixCache } from './model.ts';
import type { ToolSchema } from './tools/types.ts';
import type { ModelMessage } from 'ai';

/**
 * Harness for CACHE-1 (docs/agent-port-plan.md → "CACHE-1 — 안정적 system+tools
 * prefix에 prompt-cache breakpoints (Anthropic)").
 *
 * Verifies `aiTools`'s output structure directly (no network): with
 * `cacheable: true` exactly the LAST tool carries the Anthropic `cacheControl`
 * breakpoint and the others carry none; the no-opts / `cacheable: false` /
 * empty-schema paths attach nothing. The breakpoint placement is what the
 * `@ai-sdk/anthropic` prepareTools step reads to emit `cache_control` on the
 * wire, so asserting the tool's `providerOptions` is the meaningful check.
 *
 * Runs via `npm run harness:cache-control` under
 * `node --experimental-strip-types --import ./electron/agent/mcp-harness-register.mjs`
 * — the same loader the other agent-layer harnesses use, because `model.ts` uses
 * extensionless relative imports (and value-imports the agent chain) that the
 * loader resolves + Electron-stubs; bare strip-types can't resolve them alone.
 */

const schema = (name: string): ToolSchema => ({
  name,
  description: `desc for ${name}`,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
});

/** The Anthropic ephemeral breakpoint we expect on (only) the last tool. */
const EPHEMERAL = { type: 'ephemeral' };

/** Read a tool's `providerOptions.anthropic.cacheControl`, or undefined. */
function cacheControlOf(toolset: Record<string, { providerOptions?: unknown }>, name: string): unknown {
  const t = toolset[name];
  const po = t?.providerOptions;
  if (po && typeof po === 'object' && 'anthropic' in po) {
    const anthropic = (po as { anthropic?: unknown }).anthropic;
    if (anthropic && typeof anthropic === 'object' && 'cacheControl' in anthropic) {
      return (anthropic as { cacheControl?: unknown }).cacheControl;
    }
  }
  return undefined;
}

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/* ── (1) 3 schemas + cacheable:true → only the last has cacheControl ──────── */

{
  const names = ['alpha', 'beta', 'gamma'];
  const out = aiTools(names.map(schema), { cacheable: true }) as Record<
    string,
    { providerOptions?: unknown }
  >;
  check('3+cacheable: all three tools present', Object.keys(out).length === 3);
  check('3+cacheable: last tool (gamma) has ephemeral cacheControl', eq(cacheControlOf(out, 'gamma'), EPHEMERAL));
  check('3+cacheable: first tool (alpha) has NO cacheControl', cacheControlOf(out, 'alpha') === undefined);
  check('3+cacheable: middle tool (beta) has NO cacheControl', cacheControlOf(out, 'beta') === undefined);
}

/* ── (2) 1 schema + cacheable:true → that single tool carries it ──────────── */

{
  const out = aiTools([schema('solo')], { cacheable: true }) as Record<
    string,
    { providerOptions?: unknown }
  >;
  check('1+cacheable: single tool present', Object.keys(out).length === 1);
  check('1+cacheable: the only tool has ephemeral cacheControl', eq(cacheControlOf(out, 'solo'), EPHEMERAL));
}

/* ── (3) 3 schemas + cacheable:false → none carry it ──────────────────────── */

{
  const names = ['a', 'b', 'c'];
  const out = aiTools(names.map(schema), { cacheable: false }) as Record<
    string,
    { providerOptions?: unknown }
  >;
  check('3+cacheable:false: all three present', Object.keys(out).length === 3);
  check(
    '3+cacheable:false: no tool has cacheControl',
    names.every((n) => cacheControlOf(out, n) === undefined),
  );
}

/* ── (4) empty + cacheable:true → empty ToolSet, no throw ─────────────────── */

{
  const out = aiTools([], { cacheable: true });
  check('empty+cacheable: returns an empty ToolSet without throwing', Object.keys(out).length === 0);
}

/* ── (5) no opts → none carry it (legacy behavior preserved) ──────────────── */

{
  const names = ['x', 'y', 'z'];
  const out = aiTools(names.map(schema)) as Record<string, { providerOptions?: unknown }>;
  check('no-opts: all three present', Object.keys(out).length === 3);
  check(
    'no-opts: no tool has cacheControl (unchanged legacy behavior)',
    names.every((n) => cacheControlOf(out, n) === undefined),
  );
}

/* ── (6) cachedSystem: cacheable → SystemModelMessage w/ ephemeral breakpoint ── */

/** Read a message/system `providerOptions.anthropic.cacheControl`, or undefined. */
function msgCacheControlOf(value: { providerOptions?: unknown }): unknown {
  const po = value.providerOptions;
  if (po && typeof po === 'object' && 'anthropic' in po) {
    const anthropic = (po as { anthropic?: unknown }).anthropic;
    if (anthropic && typeof anthropic === 'object' && 'cacheControl' in anthropic) {
      return (anthropic as { cacheControl?: unknown }).cacheControl;
    }
  }
  return undefined;
}

{
  const out = cachedSystem('SYS', true);
  check('cachedSystem(true): returns a SystemModelMessage (not a string)', typeof out !== 'string');
  if (typeof out !== 'string') {
    check('cachedSystem(true): role is system', out.role === 'system');
    check('cachedSystem(true): content is preserved verbatim', out.content === 'SYS');
    check('cachedSystem(true): carries the ephemeral system breakpoint', eq(msgCacheControlOf(out), EPHEMERAL));
  }
}

/* ── (7) cachedSystem: not cacheable → plain string, byte-identical ────────── */

{
  const out = cachedSystem('SYS', false);
  check('cachedSystem(false): returns the plain string unchanged', out === 'SYS');
}

/* ── (8) withMessagePrefixCache: cacheable → breakpoint on the 2nd-to-last ──── */

{
  const transcript: ModelMessage[] = [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two' },
    { role: 'user', content: 'three (volatile tail)' },
  ];
  const out = withMessagePrefixCache(transcript, true);
  check('prefix-cache: returns a NEW array (caller transcript not mutated)', out !== transcript);
  check('prefix-cache: original messages carry no cacheControl (not mutated)', transcript.every((m) => msgCacheControlOf(m) === undefined));
  check('prefix-cache: same length', out.length === 3);
  check('prefix-cache: first message (stable prefix) has NO breakpoint', msgCacheControlOf(out[0]) === undefined);
  check('prefix-cache: second-to-last (last non-tail) has the ephemeral breakpoint', eq(msgCacheControlOf(out[1]), EPHEMERAL));
  check('prefix-cache: last message (volatile tail) has NO breakpoint', msgCacheControlOf(out[2]) === undefined);
  check('prefix-cache: breakpoint message preserves its content/role', out[1].role === 'assistant' && out[1].content === 'two');
}

/* ── (9) withMessagePrefixCache: < 2 messages / not cacheable → untouched ──── */

{
  const one: ModelMessage[] = [{ role: 'user', content: 'solo' }];
  check('prefix-cache: single message returns the original array untouched', withMessagePrefixCache(one, true) === one);
  const empty: ModelMessage[] = [];
  check('prefix-cache: empty returns the original array untouched', withMessagePrefixCache(empty, true) === empty);
  const two: ModelMessage[] = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
  ];
  check('prefix-cache: cacheable:false returns the original array untouched', withMessagePrefixCache(two, false) === two);
  check('prefix-cache: cacheable:false leaves messages breakpoint-free', two.every((m) => msgCacheControlOf(m) === undefined));
}

/* ── (10) full request: tools + system + message-prefix → <= 4 breakpoints ─── */

{
  const tools = aiTools(['t1', 't2'].map(schema), { cacheable: true }) as Record<
    string,
    { providerOptions?: unknown }
  >;
  const system = cachedSystem('SYS', true);
  const transcript: ModelMessage[] = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
  ];
  const messages = withMessagePrefixCache(transcript, true);

  const toolBreakpoints = Object.values(tools).filter((t) => msgCacheControlOf(t) !== undefined).length;
  const systemBreakpoints = typeof system === 'string' ? 0 : msgCacheControlOf(system) !== undefined ? 1 : 0;
  const messageBreakpoints = messages.filter((m) => msgCacheControlOf(m) !== undefined).length;
  const total = toolBreakpoints + systemBreakpoints + messageBreakpoints;

  check('full request: exactly one tool breakpoint', toolBreakpoints === 1);
  check('full request: exactly one system breakpoint', systemBreakpoints === 1);
  check('full request: exactly one message-prefix breakpoint', messageBreakpoints === 1);
  check('full request: total breakpoints <= 4 (Anthropic limit)', total <= 4);
  check('full request: tools breakpoint still on the LAST tool (t2)', eq(cacheControlOf(tools, 't2'), EPHEMERAL));
}

console.log(`\n${passedCount()} checks passed`);
