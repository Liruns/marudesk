import { APICallError } from 'ai';
import { check, passedCount } from '../harness-kit';
import {
  extractJsonObject,
  decomposeGoal,
  generateGraphWithFailover,
  buildRepoFactsBlock,
  buildDecomposePrompt,
} from './decompose';
import { buildModel } from './model';
import { parseWorkGraph } from '../../shared/work-os';
import type { SubagentTarget } from './subagent-resolve';
import type { ProviderId } from '../../shared/providers';

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

  /* ── repo-facts grounding: the planner prompt carries the real check command ─ */

  {
    const block = buildRepoFactsBlock({
      workspaceName: 'marudesk',
      stacks: ['TypeScript', 'ESLint'],
      checkCommands: ['npm run typecheck --silent', 'npx --no-install eslint . --format json'],
    });
    check('repo-facts: the workspace name is grounded', block.includes('Workspace: marudesk'));
    check('repo-facts: the detected stack is grounded', block.includes('TypeScript, ESLint'));
    check(
      'repo-facts: the REAL check command is grounded (not a guessed one)',
      block.includes('npm run typecheck --silent'),
    );
  }

  {
    // No checker detected → the model is told NOT to invent one, the failure mode
    // the FIX targets (a Python/Go repo getting "npm run typecheck passes").
    const block = buildRepoFactsBlock({ workspaceName: 'pyproj', stacks: [], checkCommands: [] });
    check(
      'repo-facts: no detected checker tells the model not to invent one',
      block.includes('do NOT invent one') && !block.includes('typecheck --silent'),
    );
  }

  {
    const prompt = buildDecomposePrompt('ship the thing', {
      workspaceName: 'marudesk',
      stacks: ['TypeScript'],
      checkCommands: ['npm run typecheck --silent'],
    });
    check(
      'decompose-prompt: facts precede the goal when present',
      prompt.indexOf('REPO FACTS') < prompt.indexOf('GOAL:') && prompt.includes('ship the thing'),
    );
    check(
      'decompose-prompt: the real check command rides in the assembled prompt',
      prompt.includes('npm run typecheck --silent'),
    );
  }

  {
    // No facts → the prompt is the bare goal (back-compat with the prior behavior).
    const prompt = buildDecomposePrompt('ship the thing', null);
    check(
      'decompose-prompt: null facts yields the bare GOAL prompt',
      prompt === 'GOAL:\nship the thing',
    );
  }

  /* ── generateGraphWithFailover: transient fail-over + offline-sample net ──── */

  // A model reply the real extract → parseWorkGraph gate accepts, tagged with the
  // provider that produced it so assertions can prove WHICH candidate answered.
  const graphReply = (marker: string): string =>
    JSON.stringify({
      goal: 'ship the thing',
      tasks: [
        {
          id: marker,
          title: `Do ${marker}`,
          intent: 'first task',
          kind: 'work',
          executor: { type: 'agent', ref: 'agent' },
          acceptance: [{ id: `${marker}1`, text: 'npm run typecheck passes', verdict: 'unknown' }],
        },
      ],
      edges: [],
    });

  const transient429 = (): APICallError =>
    new APICallError({
      message: 'rate limited',
      url: 'https://provider.test/v1',
      requestBodyValues: {},
      statusCode: 429,
    });

  // A faithful stub of the injectable transport seam: `resolveAuth` reports each
  // provider connected, `makeModel` builds a real (network-free) model handle, and
  // `generate` is driven per-provider by the supplied script.
  const makeDeps = (
    script: Record<string, () => Promise<{ text: string }>>,
    calls: ProviderId[],
  ): Parameters<typeof generateGraphWithFailover>[3] => {
    // `attemptGenerate` calls makeModel immediately before generate within the
    // same attempt, so the provider captured here is the one `generate` runs.
    let pending: ProviderId = 'anthropic';
    return {
      resolveAuth: async (provider) => ({
        ok: true,
        auth: { mode: 'api-key', apiKey: `${provider}-test` },
      }),
      makeModel: (provider, model, auth, baseUrl) => {
        pending = provider;
        return buildModel(provider, model, auth, baseUrl);
      },
      generate: async () => {
        calls.push(pending);
        const run = script[pending];
        if (!run) throw new Error(`unscripted provider: ${pending}`);
        return run();
      },
    };
  };

  {
    // Primary (anthropic) throws a transient 429; the openai fallback then returns
    // a real graph. Failover must reach the fallback and yield a NON-sample graph.
    const target: SubagentTarget = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      fallbacks: [{ provider: 'openai', model: 'gpt-5' }],
    };
    const calls: ProviderId[] = [];
    const deps = makeDeps(
      {
        anthropic: async () => {
          throw transient429();
        },
        openai: async () => ({ text: graphReply('b') }),
      },
      calls,
    );
    const res = await generateGraphWithFailover(target, 'ship the thing', null, deps);
    check(
      'failover: a transient 429 on the primary falls over to a connected fallback',
      res.ok === true && res.graph.tasks.length === 1 && res.graph.tasks[0].id === 'b',
    );
    check(
      'failover: BOTH the primary and the fallback were attempted, in order',
      JSON.stringify(calls) === JSON.stringify(['anthropic', 'openai']),
    );
  }

  {
    // Every connected provider throws a transient error → no graph. The caller
    // (decomposeGoal) then hands the renderer its offline sample, so this must be
    // ok:false WITHOUT inventing a graph (no regression of the offline net).
    const target: SubagentTarget = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      fallbacks: [{ provider: 'openai', model: 'gpt-5' }],
    };
    const calls: ProviderId[] = [];
    const deps = makeDeps(
      {
        anthropic: async () => {
          throw transient429();
        },
        openai: async () => {
          throw transient429();
        },
      },
      calls,
    );
    const res = await generateGraphWithFailover(target, 'ship the thing', null, deps);
    check(
      'failover: all providers failing transiently returns ok:false (renderer → offline sample)',
      res.ok === false,
    );
    check(
      'failover: every candidate in the chain was tried before giving up',
      JSON.stringify(calls) === JSON.stringify(['anthropic', 'openai']),
    );
  }

  {
    // A malformed model answer is NOT a transport failure: it must stop on the
    // FIRST provider and not burn the fallback chain re-rolling junk.
    const target: SubagentTarget = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      fallbacks: [{ provider: 'openai', model: 'gpt-5' }],
    };
    const calls: ProviderId[] = [];
    const deps = makeDeps(
      {
        anthropic: async () => ({ text: 'not json at all' }),
        openai: async () => ({ text: graphReply('b') }),
      },
      calls,
    );
    const res = await generateGraphWithFailover(target, 'ship the thing', null, deps);
    check(
      'failover: a parse failure stops early and does NOT burn the fallback',
      res.ok === false && JSON.stringify(calls) === JSON.stringify(['anthropic']),
    );
  }

  console.log(`\ndecompose harness: ${passedCount()} assertions passed`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
