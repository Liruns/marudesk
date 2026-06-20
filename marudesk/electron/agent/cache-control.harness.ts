import { check, passedCount } from '../harness-kit.ts';
import { aiTools } from './model.ts';
import type { ToolSchema } from './tools/types.ts';

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

console.log(`\n${passedCount()} checks passed`);
