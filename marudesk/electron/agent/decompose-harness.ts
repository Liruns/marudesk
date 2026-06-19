import { check, passedCount } from '../harness-kit';
import { extractJsonObject, decomposeGoal } from './decompose';
import { parseWorkGraph } from '../../shared/work-os';

/**
 * Headless harness for the decompose surface that `shared/work-os.test.ts` does
 * NOT cover: {@link extractJsonObject}'s brace/string-balance scanner and
 * {@link decomposeGoal}'s provider-free early returns (the input guards that
 * fire before any provider is resolved). One integration assert exercises the
 * real extract → parseWorkGraph gate the decompose call depends on.
 *
 * Pure and provider-free, so it runs standalone via `npm run harness:decompose`.
 * The "no provider connected" path is deliberately NOT asserted here — it calls
 * resolveSubagentTarget and is environment-dependent/slow; every check below is
 * deterministic.
 */

async function main(): Promise<void> {
  /* ── extractJsonObject ──────────────────────────────────────────────────── */

  {
    const out = extractJsonObject('{"a":1}');
    check('extract: a bare object parses', JSON.stringify(out) === '{"a":1}');
  }

  {
    const fenced = '```json\n{"a":1,"b":2}\n```';
    const out = extractJsonObject(fenced);
    check('extract: a fenced ```json block parses', JSON.stringify(out) === '{"a":1,"b":2}');
  }

  {
    const text = 'Here is the plan you asked for:\n{"a":1}\nLet me know if that works.';
    const out = extractJsonObject(text);
    check('extract: leading AND trailing prose is stripped', JSON.stringify(out) === '{"a":1}');
  }

  {
    // A value that literally contains the characters } and { must not throw off
    // the depth tracker — the scanner has to ignore braces inside string values.
    const text = '{"note":"close } then open { inside a value","ok":true}';
    const out = extractJsonObject(text);
    const obj = out as { note: string; ok: boolean } | null;
    check(
      'extract: braces inside a JSON string value do not break balance tracking',
      obj !== null && obj.note === 'close } then open { inside a value' && obj.ok === true,
    );
  }

  {
    const out = extractJsonObject('{"a":1,}'); // trailing comma → invalid JSON
    check('extract: malformed JSON returns null', out === null);
  }

  {
    // Opened but never balanced: the scanner must fall through to null, not emit a partial slice.
    const out = extractJsonObject('prefix {"a":1 and never closes');
    check('extract: an unterminated object returns null', out === null);
  }

  {
    const out = extractJsonObject('there is no object here at all');
    check('extract: text with no opening brace returns null', out === null);
  }

  {
    // Several balanced objects in a row → the FIRST one wins.
    const text = '{"first":1} and then {"second":2}';
    const out = extractJsonObject(text);
    check('extract: returns the FIRST balanced object', JSON.stringify(out) === '{"first":1}');
  }

  /* ── decomposeGoal provider-free early returns ──────────────────────────── */

  {
    const res = await decomposeGoal('');
    check(
      'decompose: empty goal returns the "Enter a goal first." gate',
      res.ok === false && res.reason === 'Enter a goal first.',
    );
  }

  {
    const res = await decomposeGoal('   ');
    check(
      'decompose: whitespace-only goal hits the same empty gate',
      res.ok === false && res.reason === 'Enter a goal first.',
    );
  }

  {
    const res = await decomposeGoal('x'.repeat(8_001)); // over the 8000-char cap
    check(
      'decompose: an over-length goal is rejected as too long',
      res.ok === false && /too long/i.test(res.reason),
    );
  }

  /* ── integration: extract → parseWorkGraph (the real decompose pipe) ─────── */

  {
    const reply = [
      'Sure, here is a small task graph for that goal.',
      '',
      '```json',
      JSON.stringify({
        goal: 'ship the thing',
        tasks: [
          {
            id: 'a',
            title: 'Do A',
            intent: 'A must exist before B',
            kind: 'work',
            executor: { type: 'agent', ref: 'agent' },
            acceptance: [{ id: 'a1', text: 'npm run typecheck passes', verdict: 'unknown' }],
          },
          {
            id: 'b',
            title: 'Do B',
            intent: 'B builds on A',
            kind: 'work',
            executor: { type: 'agent', ref: 'agent' },
            acceptance: [{ id: 'b1', text: 'endpoint returns 200', verdict: 'unknown' }],
          },
        ],
        edges: [{ from: 'a', to: 'b', type: 'depends_on' }],
      }),
      '```',
      '',
      'Let me know if you want me to run it.',
    ].join('\n');

    const graph = parseWorkGraph(extractJsonObject(reply));
    check('integration: extract → parseWorkGraph yields a non-null graph', graph !== null);
    check(
      'integration: parsed task ids are ["a","b"]',
      graph !== null && JSON.stringify(graph.tasks.map((t) => t.id)) === '["a","b"]',
    );
    check('integration: exactly one edge survives the gate', graph !== null && graph.edges.length === 1);
  }

  console.log(`\ndecompose harness: ${passedCount()} assertions passed`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
