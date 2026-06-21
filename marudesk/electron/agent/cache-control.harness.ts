import { check, passedCount } from '../harness-kit.ts';
import { aiTools, cachedSystem, SYSTEM_SECTION_SEPARATOR, withMessagePrefixCache, cacheReadTokensOf } from './model.ts';
import { emptyAgentChatState } from '../../shared/agent.ts';
import type { ToolSchema } from './tools/types.ts';
import type { LanguageModelUsage, ModelMessage } from 'ai';

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
  // No volatile tail → a single cached SystemModelMessage (back-compat shape).
  const out = cachedSystem('SYS', '', true);
  check('cachedSystem(true,no-tail): returns a SystemModelMessage (not a string/array)', typeof out !== 'string' && !Array.isArray(out));
  if (typeof out !== 'string' && !Array.isArray(out)) {
    check('cachedSystem(true,no-tail): role is system', out.role === 'system');
    check('cachedSystem(true,no-tail): content is preserved verbatim', out.content === 'SYS');
    check('cachedSystem(true,no-tail): carries the ephemeral system breakpoint', eq(msgCacheControlOf(out), EPHEMERAL));
  }
}

/* ── (7) cachedSystem: not cacheable → plain string, byte-identical ────────── */

{
  const out = cachedSystem('SYS', '', false);
  check('cachedSystem(false,no-tail): returns the plain string unchanged', out === 'SYS');
  // With a volatile tail, the non-cacheable string re-joins head + tail with the
  // shared section separator so non-Anthropic providers see identical content.
  const joined = cachedSystem('SYS', 'ENV', false);
  check(
    'cachedSystem(false,+tail): re-joins head + tail with the section separator',
    joined === `SYS${SYSTEM_SECTION_SEPARATOR}ENV`,
  );
}

/* ── (6b) cachedSystem: cacheable + volatile tail → two system blocks, head cached only ── */

{
  const out = cachedSystem('SYS', 'ENV', true);
  check('cachedSystem(true,+tail): returns an ARRAY of system messages', Array.isArray(out));
  if (Array.isArray(out)) {
    check('cachedSystem(true,+tail): exactly two system blocks', out.length === 2);
    check('cachedSystem(true,+tail): both blocks are role:system', out.every((m) => m.role === 'system'));
    check('cachedSystem(true,+tail): head holds the stable content', out[0].content === 'SYS');
    check('cachedSystem(true,+tail): tail holds the volatile grounding', out[1].content === 'ENV');
    check('cachedSystem(true,+tail): ONLY the stable head carries the breakpoint', eq(msgCacheControlOf(out[0]), EPHEMERAL));
    check('cachedSystem(true,+tail): the volatile tail carries NO breakpoint', msgCacheControlOf(out[1]) === undefined);
  }
}

/* ── (6c) CROSS-TURN STABILITY: the cached head is byte-identical across two ──
 * turns whose only difference is the volatile env grounding (git dirty count /
 * HEAD subject / date). This is the CACHE-1 regression the fix targets: a
 * working-tree edit must NOT change the cached system segment, while the env
 * facts still reach the model in the (uncached) tail block. */

{
  // Same stable head; two DIFFERENT volatile env blocks (turn A clean, turn B
  // dirty with a new HEAD) — exactly what changes when the agent edits/commits.
  const head = 'BASE RULES + MODEL GUIDANCE + INSTRUCTIONS + FOOTER';
  const envTurnA = '<environment>\nToday: 2026-06-21\nGit: branch main, clean, HEAD a1b2c3 first\n</environment>';
  const envTurnB = '<environment>\nToday: 2026-06-22\nGit: branch main, 3 uncommitted changes, HEAD d4e5f6 second\n</environment>';

  const turnA = cachedSystem(head, envTurnA, true);
  const turnB = cachedSystem(head, envTurnB, true);
  check('cross-turn: both turns produce a two-block array', Array.isArray(turnA) && Array.isArray(turnB));
  if (Array.isArray(turnA) && Array.isArray(turnB)) {
    // THE key assertion: the cached head block is byte-identical across turns.
    check('cross-turn: cached head CONTENT is byte-identical across turns', turnA[0].content === turnB[0].content);
    check(
      'cross-turn: cached head PROVIDER-OPTIONS are byte-identical across turns',
      JSON.stringify(turnA[0].providerOptions) === JSON.stringify(turnB[0].providerOptions),
    );
    check('cross-turn: cached head still carries the ephemeral breakpoint', eq(msgCacheControlOf(turnA[0]), EPHEMERAL));
    // …while the volatile grounding still REACHES the model, and differs per turn.
    check('cross-turn: env grounding still reaches the model (turn A tail = env A)', turnA[1].content === envTurnA);
    check('cross-turn: env grounding still reaches the model (turn B tail = env B)', turnB[1].content === envTurnB);
    check('cross-turn: the volatile tail DOES differ across turns (proves grounding is live)', turnA[1].content !== turnB[1].content);
    // Neither volatile tail carries a breakpoint (so it can never be a cache prefix).
    check('cross-turn: neither volatile tail carries a breakpoint', msgCacheControlOf(turnA[1]) === undefined && msgCacheControlOf(turnB[1]) === undefined);
  }
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
  // A realistic system split: a stable head + a volatile env tail → two system
  // blocks, but still only ONE system breakpoint (on the head).
  const system = cachedSystem('SYS', 'ENV', true);
  const transcript: ModelMessage[] = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
  ];
  const messages = withMessagePrefixCache(transcript, true);

  const systemBlocks = typeof system === 'string' ? [] : Array.isArray(system) ? system : [system];
  const toolBreakpoints = Object.values(tools).filter((t) => msgCacheControlOf(t) !== undefined).length;
  const systemBreakpoints = systemBlocks.filter((m) => msgCacheControlOf(m) !== undefined).length;
  const messageBreakpoints = messages.filter((m) => msgCacheControlOf(m) !== undefined).length;
  const total = toolBreakpoints + systemBreakpoints + messageBreakpoints;

  check('full request: exactly one tool breakpoint', toolBreakpoints === 1);
  check('full request: exactly one system breakpoint (on the stable head only)', systemBreakpoints === 1);
  check('full request: exactly one message-prefix breakpoint', messageBreakpoints === 1);
  check('full request: total breakpoints <= 4 (Anthropic limit)', total <= 4);
  check('full request: tools breakpoint still on the LAST tool (t2)', eq(cacheControlOf(tools, 't2'), EPHEMERAL));
}

/* ── (11) cache observability: cachedInputTokens is threaded onto the usage shape ── */

{
  // The renderer-facing chat usage struct must carry the additive cache-read
  // field ALONGSIDE the existing totals, so a degraded hit rate is observable.
  const usage = emptyAgentChatState().usage;
  check('usage shape: keeps inputTokens', usage.inputTokens === 0);
  check('usage shape: keeps outputTokens', usage.outputTokens === 0);
  check('usage shape: keeps contextTokens', usage.contextTokens === 0);
  // Optional + additive: the field is assignable on the struct without breaking
  // the existing literals (it starts absent, the loop populates it each step).
  const surfaced: typeof usage = { ...usage, cachedInputTokens: 1234 };
  check('usage shape: cachedInputTokens is surfaced alongside the totals', surfaced.cachedInputTokens === 1234);
}

/* ── (12) cacheReadTokensOf: structured field preferred, deprecated alias fallback, else 0 ── */

{
  const base: LanguageModelUsage = {
    inputTokens: 100,
    outputTokens: 10,
    totalTokens: 110,
    inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
  };

  const structured: LanguageModelUsage = {
    ...base,
    inputTokenDetails: { noCacheTokens: 40, cacheReadTokens: 60, cacheWriteTokens: 0 },
    cachedInputTokens: 999, // deprecated alias should be IGNORED when the structured field is present
  };
  check('cacheReadTokensOf: prefers inputTokenDetails.cacheReadTokens', cacheReadTokensOf(structured) === 60);

  const aliasOnly: LanguageModelUsage = { ...base, cachedInputTokens: 42 };
  check('cacheReadTokensOf: falls back to the deprecated cachedInputTokens alias', cacheReadTokensOf(aliasOnly) === 42);

  check('cacheReadTokensOf: 0 when neither cache field is reported', cacheReadTokensOf(base) === 0);
}

console.log(`\n${passedCount()} checks passed`);
