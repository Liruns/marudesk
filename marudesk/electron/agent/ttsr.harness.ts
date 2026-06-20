import { check, passedCount } from '../harness-kit.ts';
import { TtsrManager, type TtsrRule } from './ttsr-manager.ts';

/**
 * Harness for the pure TTSR mid-stream rule matcher (SECOND-PASS item 6). Pure +
 * dependency-free — runs standalone under `node --experimental-strip-types`.
 *
 * Covers the inert default (no false positives when disabled), buffered delta
 * matching across chunk boundaries, source scoping, path-glob tool scoping, the
 * once/always/gap repeat gating, per-source buffer isolation, and bad-regex
 * tolerance. The live abort+retry is DEFERRED — only the matcher is tested.
 */

const protectRule: TtsrRule = {
  name: 'protect-env',
  condition: ['\\.env'],
  reminder: 'Do not write to .env files.',
  scope: ['text', 'tool'],
};

/* ── inert by default (the loop's safe hook point) ────────────────────────── */
{
  const inert = new TtsrManager([protectRule]); // enabled defaults to false
  check('inert manager is not active', !inert.active);
  check('inert checkDelta never matches', inert.checkDelta('writing .env now', { source: 'text' }).length === 0);
}

/* ── buffered matching across chunk boundaries ────────────────────────────── */
{
  const m = new TtsrManager([protectRule], { enabled: true });
  check('enabled manager with rules is active', m.active);
  // The pattern is split across two deltas — the buffer must stitch them.
  check('first half does not match yet', m.checkDelta('please edit .e', { source: 'text' }).length === 0);
  const hit = m.checkDelta('nv config', { source: 'text' });
  check('match fires once the buffer completes the pattern', hit.length === 1);
  check('match carries the rule name + reminder', hit[0].name === 'protect-env' && hit[0].reminder.includes('.env'));
}

/* ── source scoping ───────────────────────────────────────────────────────── */
{
  const textOnly = new TtsrManager(
    [{ name: 'r', condition: ['danger'], reminder: 'x', scope: ['text'] }],
    { enabled: true },
  );
  check('matches its scoped source', textOnly.checkDelta('danger', { source: 'text' }).length === 1);
  check('ignores an out-of-scope source', textOnly.checkDelta('danger', { source: 'thinking' }).length === 0);
}

/* ── path-glob tool scoping ───────────────────────────────────────────────── */
{
  const globRule: TtsrRule = {
    name: 'protect-secrets',
    condition: ['.'], // any content
    reminder: 'no',
    scope: ['tool'],
    globs: ['**/secrets/**', '*.pem'],
  };
  const m = new TtsrManager([globRule], { enabled: true });
  check(
    'tool chunk with a matching path fires',
    m.checkDelta('x', { source: 'tool', toolName: 'edit_file', filePaths: ['src/secrets/key.ts'] }).length === 1,
  );
  // Different tool buffer key — fresh manager to avoid the once-gate from above.
  const m2 = new TtsrManager([globRule], { enabled: true });
  check(
    'tool chunk with a non-matching path does not fire',
    m2.checkDelta('x', { source: 'tool', toolName: 'edit_file', filePaths: ['src/app.ts'] }).length === 0,
  );
  const m3 = new TtsrManager([globRule], { enabled: true });
  check(
    'basename glob matches a .pem file',
    m3.checkDelta('x', { source: 'tool', toolName: 'edit_file', filePaths: ['deep/dir/server.pem'] }).length === 1,
  );
  const m4 = new TtsrManager([globRule], { enabled: true });
  check(
    'glob rule with no candidate paths does not fire',
    m4.checkDelta('x', { source: 'tool', toolName: 'edit_file' }).length === 0,
  );
}

/* ── repeat gating: once / always / gap ───────────────────────────────────── */
{
  const once = new TtsrManager([protectRule], { enabled: true, repeatMode: 'once' });
  const first = once.checkDelta('.env', { source: 'text' });
  check('once: first hit fires', first.length === 1);
  once.markInjected(first.map((r) => r.name));
  once.resetBuffers();
  check('once: second hit is gated', once.checkDelta('.env again', { source: 'text' }).length === 0);

  const always = new TtsrManager([protectRule], { enabled: true, repeatMode: 'always' });
  const a1 = always.checkDelta('.env', { source: 'text' });
  always.markInjected(a1.map((r) => r.name));
  always.resetBuffers();
  check('always: fires again after injection', always.checkDelta('.env', { source: 'text' }).length === 1);

  const gap = new TtsrManager([protectRule], { enabled: true, repeatMode: 'gap', repeatGap: 2 });
  const g1 = gap.checkDelta('.env', { source: 'text' });
  gap.markInjected(g1.map((r) => r.name));
  gap.resetBuffers();
  check('gap: still gated within the gap', gap.checkDelta('.env', { source: 'text' }).length === 0);
  gap.advanceMark();
  gap.advanceMark();
  gap.resetBuffers();
  check('gap: fires again once the gap elapses', gap.checkDelta('.env', { source: 'text' }).length === 1);
}

/* ── per-source buffer isolation + bad regex tolerance ────────────────────── */
{
  const m = new TtsrManager(
    [{ name: 'r', condition: ['abc'], reminder: 'x', scope: ['text', 'thinking'] }],
    { enabled: true },
  );
  // 'ab' to text, 'c' to thinking — must NOT stitch across the two buffers.
  m.checkDelta('ab', { source: 'text' });
  check('buffers do not bleed across sources', m.checkDelta('c', { source: 'thinking' }).length === 0);

  // A rule with only an invalid regex is dropped at add time.
  const bad = new TtsrManager([{ name: 'bad', condition: ['('], reminder: 'x' }], { enabled: true });
  check('rule with only a bad regex is not active', !bad.active);
}

console.log(`\n${passedCount()} checks passed`);
