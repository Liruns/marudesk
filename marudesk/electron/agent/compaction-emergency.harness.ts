import type { ModelMessage } from 'ai';
import { check, passedCount } from '../harness-kit.ts';
import {
  EMERGENCY_MESSAGE_COUNT,
  EMERGENCY_TRANSCRIPT_CHARS,
  emergencyCompactionReason,
  messageChars,
} from './compaction-utils.ts';

/**
 * Harness for the COMPACT-2 emergency compaction floor
 * (docs/agent-port-plan.md → "COMPACT-2 — 80% 토큰 임계 아래의 emergency
 * compaction floor").
 *
 * Pure + dependency-free: `compaction-utils.ts` imports only `type ModelMessage`
 * (stripped at runtime), so this runs standalone via
 * `npm run harness:compaction-emergency` under bare
 * `node --experimental-strip-types` — no Electron stub needed.
 *
 * Covers the doc's acceptance criteria: below both floors → null; the message
 * count boundary (=500 → null, +1 → 'messageCount'); the transcript char
 * boundary (=4_000_000 → null, +1 → 'transcriptChars'); and both exceeded →
 * 'messageCount' wins.
 */

/* ── constants match the doc ────────────────────────────────────────────── */

check('EMERGENCY_MESSAGE_COUNT is 500', EMERGENCY_MESSAGE_COUNT === 500);
check('EMERGENCY_TRANSCRIPT_CHARS is 4_000_000', EMERGENCY_TRANSCRIPT_CHARS === 4_000_000);

/* ── below both floors → null ───────────────────────────────────────────── */

check('below both floors → null', emergencyCompactionReason(10, 10_000) === null);
check('zero/empty transcript → null', emergencyCompactionReason(0, 0) === null);

/* ── message-count boundary (strict >) ──────────────────────────────────── */

check('length === 500 → null (boundary, not over)', emergencyCompactionReason(500, 0) === null);
check('length === 501 → messageCount', emergencyCompactionReason(501, 0) === 'messageCount');

/* ── transcript-char boundary (strict >) ────────────────────────────────── */

check('chars === 4_000_000 → null (boundary, not over)', emergencyCompactionReason(0, 4_000_000) === null);
check(
  'chars === 4_000_001 with count under floor → transcriptChars',
  emergencyCompactionReason(10, 4_000_001) === 'transcriptChars',
);

/* ── both exceeded → messageCount wins (precedence) ─────────────────────── */

check(
  'both floors exceeded → messageCount takes precedence',
  emergencyCompactionReason(501, 4_000_001) === 'messageCount',
);

/* ── end-to-end via messageChars over a ModelMessage[] transcript ───────── */

{
  // A string-content message's char weight is its content length; sum it the
  // same way loop.ts's shouldEmergencyCompact does, then feed the reason fn.
  const big = 'x'.repeat(EMERGENCY_TRANSCRIPT_CHARS + 1);
  const transcript: ModelMessage[] = [{ role: 'user', content: big }];
  const transcriptChars = transcript.reduce((n, m) => n + messageChars(m), 0);
  check('messageChars sums string content by length', transcriptChars === EMERGENCY_TRANSCRIPT_CHARS + 1);
  check(
    'transcript over char floor (count under) → transcriptChars',
    emergencyCompactionReason(transcript.length, transcriptChars) === 'transcriptChars',
  );
}

{
  // A short transcript that is well under both floors yields null end-to-end.
  const transcript: ModelMessage[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ];
  const transcriptChars = transcript.reduce((n, m) => n + messageChars(m), 0);
  check(
    'short transcript under both floors → null end-to-end',
    emergencyCompactionReason(transcript.length, transcriptChars) === null,
  );
}

console.log(`\n${passedCount()} checks passed`);
