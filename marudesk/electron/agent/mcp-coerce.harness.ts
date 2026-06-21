import { check, passedCount } from '../harness-kit.ts';
import {
  isMalformedMcpResult,
  coerceMalformedMcpResult,
  toToolResult,
} from './mcp-content.ts';
import type { McpCallToolResult } from './mcp-external.ts';

/**
 * Harness for the coerceToolResult boundary guard (SECOND-PASS item 5). Pure:
 * `mcp-content.ts` imports only shared `scrub`/`text-clip` (no Electron), so this
 * runs standalone under `node --experimental-strip-types`.
 *
 * Covers the malformed-shape detector (null / non-object / missing content) and
 * that {@link toToolResult} NEVER THROWS on a malformed external result — it
 * returns a safe `isError` result so the loop can keep the transcript valid
 * instead of orphaning a tool_use mid-loop. Also asserts conformant shapes still
 * map normally (no regression).
 */

/* ── malformed-shape detection (only the unreadable, would-throw shapes) ──── */
{
  // The throw risk is a NON-OBJECT — reading `.content` off it throws / is junk.
  check('null is malformed', isMalformedMcpResult(null));
  check('undefined is malformed', isMalformedMcpResult(undefined));
  check('string is malformed', isMalformedMcpResult('oops'));
  check('number is malformed', isMalformedMcpResult(42));

  // An object that merely OMITS content degrades gracefully → NOT malformed, so
  // the existing "(no content)" behavior is preserved (no regression).
  check('bare {} is NOT malformed (graceful no-content)', !isMalformedMcpResult({}));
  check('{content:"x"} is NOT malformed (graceful no-content)', !isMalformedMcpResult({ content: 'x' }));
  check('content array is OK', !isMalformedMcpResult({ content: [{ type: 'text', text: 'hi' }] }));
  check('empty content array is OK', !isMalformedMcpResult({ content: [] }));
  check('structuredContent only is OK', !isMalformedMcpResult({ structuredContent: { a: 1 } }));
  check('isError:true with no content is OK', !isMalformedMcpResult({ isError: true }));
}

/* ── coerceMalformedMcpResult shape ──────────────────────────────────────── */
{
  const r = coerceMalformedMcpResult('weather__forecast');
  check('coerced result is an error', r.isError === true);
  check('coerced result names the tool', r.summary.includes('weather__forecast'));
  check('coerced result has non-empty text', typeof r.text === 'string' && r.text.length > 0);
}

/* ── toToolResult never throws, and non-object results become safe errors ──── */
{
  // The real mid-loop throw risk: a server resolves `null` / a non-object, and
  // toToolResult used to read `.content` off it → TypeError. Now → safe isError.
  const unreadable: unknown[] = [null, undefined, 'plain string', 123];
  let threw = false;
  let allError = true;
  for (const bad of unreadable) {
    try {
      const out = toToolResult('ext__tool', bad as McpCallToolResult);
      if (out.isError !== true) allError = false;
    } catch {
      threw = true;
    }
  }
  check('toToolResult never throws on non-object input', !threw);
  check('every non-object input → isError result', allError);

  // Graceful-empty objects must NOT throw either, and stay non-error "(no content)".
  let graceThrew = false;
  let graceOk = true;
  for (const empty of [{}, { content: 'not-an-array' }] as unknown[]) {
    try {
      const out = toToolResult('ext__tool', empty as McpCallToolResult);
      // Third-party text is wrapped in untrusted-tool-output sentinels, so the
      // "(no content)" placeholder is contained, not byte-equal.
      if (out.isError === true || !out.text.includes('(no content)')) graceOk = false;
    } catch {
      graceThrew = true;
    }
  }
  check('graceful-empty object does not throw', !graceThrew);
  check('graceful-empty object → non-error "(no content)"', graceOk);
}

/* ── conformant results still map normally (no regression) ───────────────── */
{
  const ok = toToolResult('ext__echo', { content: [{ type: 'text', text: 'hello world' }] });
  check('text content maps through', ok.text.includes('hello world'));
  check('non-error text result is not isError', ok.isError !== true);

  const err = toToolResult('ext__fail', { content: [{ type: 'text', text: 'boom' }], isError: true });
  check('isError flag carries through', err.isError === true);

  const structured = toToolResult('ext__data', { structuredContent: { ok: 1 } } as McpCallToolResult);
  check('structuredContent-only still maps', structured.text.includes('"ok":1') && structured.isError !== true);
}

console.log(`\n${passedCount()} checks passed`);
