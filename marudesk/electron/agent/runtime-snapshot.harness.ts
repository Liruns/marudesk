import { check, passedCount } from '../harness-kit.ts';
import { deriveRuntimeSnapshot, type OrchestrationThreadEntry } from './orchestration-state.ts';
import { RUNTIME_SNAPSHOT_VERSION } from '../../shared/agent-orchestration.ts';
import {
  saveContinuation,
  loadContinuation,
  clearContinuations,
  continuationCount,
} from './subagent-continuation.ts';
import type { ModelMessage } from 'ai';

/**
 * Harness for the typed runtime snapshot (SECOND-PASS "Typed runtime snapshot")
 * and the sub-session continuation store (SECOND-PASS "Sub-session continuation
 * ID"). Both are pure data; runs under bare `node --experimental-strip-types`.
 *
 * Snapshot: shape + totals roll-up + active-first sort + background enumeration.
 * Continuation: save→load round-trip, defensive copy, LRU eviction, clear.
 */

/** A minimal structural stand-in for a ThreadContainer the derive reads. */
function fakeEntry(
  id: string,
  active: boolean,
  opts: {
    status?: string;
    title?: string;
    provider?: string;
    model?: string;
    startedAt?: number;
    usage?: { inputTokens: number; outputTokens: number; contextTokens: number };
    background?: { id: string; label: string; status: string; provider: string; model: string; startedAt: number; finishedAt: number | null }[];
    starting?: boolean;
  } = {},
): OrchestrationThreadEntry {
  const container = {
    workspaceId: null,
    starting: opts.starting ?? false,
    conversationProvider: opts.provider ?? '',
    conversationModel: opts.model ?? '',
    conversationTitle: opts.title ?? '',
    conversationStartedAt: opts.startedAt ?? 0,
    state: {
      status: opts.status ?? 'idle',
      usage: opts.usage ?? { inputTokens: 0, outputTokens: 0, contextTokens: 0 },
      background: opts.background ?? [],
    },
  } as unknown as OrchestrationThreadEntry['container'];
  return { id, container, active };
}

/* ── snapshot: shape + totals + sort + background ───────────────────────── */
{
  const entries: OrchestrationThreadEntry[] = [
    fakeEntry('t-b', false, { status: 'idle', title: 'Beta' }),
    fakeEntry('t-a', true, {
      status: 'working',
      title: 'Alpha',
      provider: 'anthropic',
      model: 'claude-test',
      startedAt: 1000,
      usage: { inputTokens: 10, outputTokens: 20, contextTokens: 30 },
      background: [
        { id: 'bg1', label: 'research', status: 'running', provider: 'anthropic', model: 'm', startedAt: 1, finishedAt: null },
        { id: 'bg2', label: 'done one', status: 'completed', provider: 'anthropic', model: 'm', startedAt: 1, finishedAt: 9 },
      ],
    }),
  ];
  const snap = deriveRuntimeSnapshot(entries, 42);
  check('snapshot carries the stable version', snap.version === RUNTIME_SNAPSHOT_VERSION);
  check('snapshot capturedAt is injectable', snap.capturedAt === 42);
  check('active thread sorts first', snap.threads[0].id === 't-a' && snap.threads[1].id === 't-b');
  const a = snap.threads[0];
  check('thread fields project through', a.title === 'Alpha' && a.provider === 'anthropic' && a.model === 'claude-test' && a.startedAt === 1000);
  check('busy reflects working status', a.busy === true);
  check('usage projects through', a.usage.inputTokens === 10 && a.usage.outputTokens === 20 && a.usage.contextTokens === 30);
  check('background agents enumerated + counted', a.backgroundCount === 2 && a.background.length === 2);
  check('background running flag derived', a.background[0].running === true && a.background[1].running === false);
  check('empty provider/model project as null', snap.threads[1].provider === null && snap.threads[1].model === null);
  check(
    'totals roll up across threads',
    snap.totals.threads === 2 &&
      snap.totals.busyThreads === 1 &&
      snap.totals.backgroundAgents === 2 &&
      snap.totals.runningBackgroundAgents === 1,
  );
}

/* ── snapshot: empty input ──────────────────────────────────────────────── */
{
  const snap = deriveRuntimeSnapshot([], 0);
  check('empty input → zero totals', snap.threads.length === 0 && snap.totals.threads === 0 && snap.totals.backgroundAgents === 0);
}

/* ── continuation: round-trip + defensive copy ──────────────────────────── */
{
  clearContinuations();
  const transcript: ModelMessage[] = [{ role: 'user', content: 'hello' }];
  const id = saveContinuation(transcript);
  check('saveContinuation returns a sub- id', /^sub-/.test(id));
  transcript.push({ role: 'assistant', content: 'mutated after save' });
  const loaded = loadContinuation(id);
  check('loaded transcript is the defensive copy (1 message, not 2)', loaded?.length === 1);
  check('loading an unknown id returns null', loadContinuation('sub-nope') === null);
}

/* ── continuation: LRU eviction + clear ─────────────────────────────────── */
{
  clearContinuations();
  const ids: string[] = [];
  for (let i = 0; i < 40; i += 1) ids.push(saveContinuation([{ role: 'user', content: `m${i}` }]));
  check('store is capped (<= 32)', continuationCount() <= 32);
  check('the oldest id was evicted', loadContinuation(ids[0]) === null);
  check('the newest id survives', loadContinuation(ids[ids.length - 1]) !== null);
  clearContinuations();
  check('clearContinuations empties the store', continuationCount() === 0);
}

console.log(`\nruntime-snapshot harness: ${passedCount()} checks passed`);
