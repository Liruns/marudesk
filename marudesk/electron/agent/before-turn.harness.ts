import { check, passedCount } from '../harness-kit.ts';
import {
  registerBeforeTurnContributor,
  runBeforeTurnContributors,
  type BeforeTurnMeta,
} from './before-turn.ts';

/**
 * Harness for the HOOK-1 before-turn contributor seam
 * (docs/agent-port-plan.md → "HOOK-1 — Before-turn 기여자 seam").
 *
 * Pure + dependency-free (the seam imports no Electron), so it runs standalone
 * via `npm run harness:before-turn` under bare `node --experimental-strip-types`.
 * Covers the doc's acceptance criteria: empty registry → []; null/undefined
 * contribute nothing; priority order incl. reverse registration; same-priority
 * registration order; a throwing contributor is skipped; unregister removes it.
 */

const META: BeforeTurnMeta = {
  ws: '/tmp/ws',
  approvalMode: 'ask',
  provider: 'anthropic',
  modelId: 'claude-test',
};

/* ── empty registry ─────────────────────────────────────────────────────── */

{
  const out = await runBeforeTurnContributors(META);
  check('empty registry returns []', Array.isArray(out) && out.length === 0);
}

/* ── null / undefined / empty contribute nothing ────────────────────────── */

{
  const offA = registerBeforeTurnContributor('normal', async () => null);
  const offB = registerBeforeTurnContributor('normal', async () => undefined);
  const offC = registerBeforeTurnContributor('normal', async () => '   ');
  const offD = registerBeforeTurnContributor('normal', async () => 'kept');
  const out = await runBeforeTurnContributors(META);
  check('null/undefined/whitespace drop, only non-empty kept', out.length === 1 && out[0] === 'kept');
  check('returned strings are trimmed', out[0] === 'kept');
  offA();
  offB();
  offC();
  offD();
}

/* ── priority order, registered in REVERSE order ────────────────────────── */

{
  // Register low → normal → high → critical; expect critical → high → normal → low.
  const offLow = registerBeforeTurnContributor('low', async () => 'low');
  const offNormal = registerBeforeTurnContributor('normal', async () => 'normal');
  const offHigh = registerBeforeTurnContributor('high', async () => 'high');
  const offCritical = registerBeforeTurnContributor('critical', async () => 'critical');
  const out = await runBeforeTurnContributors(META);
  check(
    'priority order critical→high→normal→low despite reverse registration',
    out.join('|') === 'critical|high|normal|low',
  );
  offLow();
  offNormal();
  offHigh();
  offCritical();
}

/* ── same-priority preserves registration order ─────────────────────────── */

{
  const off1 = registerBeforeTurnContributor('normal', async () => 'first');
  const off2 = registerBeforeTurnContributor('normal', async () => 'second');
  const off3 = registerBeforeTurnContributor('normal', async () => 'third');
  const out = await runBeforeTurnContributors(META);
  check('same-priority keeps registration order', out.join('|') === 'first|second|third');
  off1();
  off2();
  off3();
}

/* ── a throwing contributor is skipped, the rest still run ──────────────── */

{
  const offA = registerBeforeTurnContributor('high', async () => 'before');
  const offThrow = registerBeforeTurnContributor('normal', async () => {
    throw new Error('boom');
  });
  const offB = registerBeforeTurnContributor('low', async () => 'after');
  const out = await runBeforeTurnContributors(META);
  check('a throwing contributor is non-fatal; the rest still run', out.join('|') === 'before|after');
  offA();
  offThrow();
  offB();
}

/* ── unregister removes the contributor from later runs ─────────────────── */

{
  const off = registerBeforeTurnContributor('normal', async () => 'temp');
  const before = await runBeforeTurnContributors(META);
  check('contributor present before unregister', before.join('|') === 'temp');
  off();
  const after = await runBeforeTurnContributors(META);
  check('unregister removes the contributor', after.length === 0);
  // Unregister is idempotent — calling it again must be a safe no-op.
  off();
  const again = await runBeforeTurnContributors(META);
  check('double unregister is a safe no-op', again.length === 0);
}

/* ── meta reaches the contributor read-only ─────────────────────────────── */

{
  const seen: BeforeTurnMeta[] = [];
  const off = registerBeforeTurnContributor('normal', async (meta) => {
    seen.push(meta);
    return null;
  });
  await runBeforeTurnContributors(META);
  off();
  const m = seen[0];
  check(
    'contributor receives the meta snapshot',
    seen.length === 1 &&
      m.ws === '/tmp/ws' &&
      m.approvalMode === 'ask' &&
      m.provider === 'anthropic' &&
      m.modelId === 'claude-test',
  );
}

console.log(`\n${passedCount()} checks passed`);
