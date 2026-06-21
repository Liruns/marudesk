import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Resource } from '../../shared/work-os';
import type { Diagnostic, DiagnosticsRun } from '../../shared/diagnostics';
import { check, passedCount } from '../harness-kit';
import {
  parseInput,
  extractArtifacts,
  resolveOutputs,
  stripJsonFences,
  firstJsonObject,
  runTask,
  probeChangedFiles,
  runVerifyFixLoop,
  verifyNoteFor,
  implementPrompt,
} from './run-task';

/**
 * Harness for the pure helpers behind {@link runTask} (electron/agent/run-task.ts —
 * the Work-OS `workos:run-task` flow). Sibling to workos-apply.harness.ts, which
 * already covers applyTaskPatch end-to-end; this one exercises the OTHER, untested
 * surface: payload validation (parseInput), the prose-tolerant JSON scanner
 * (firstJsonObject), artifact extraction (extractArtifacts), the security-critical
 * artifact→Resource resolution against a REAL temp workspace (resolveOutputs), the
 * fence stripper (stripJsonFences), and runTask's provider-free early returns.
 *
 * Pure/IO-only — no AI provider is reached — so it runs headless via
 * `npm run harness:run-task`.
 */

/** Map a resolved file:// Resource back to a workspace-relative POSIX path. */
function relOf(root: string, res: Resource): string {
  return path.relative(root, fileURLToPath(res.uri)).replace(/\\/g, '/');
}

function testParseInput(): void {
  check('parseInput: non-object → null', parseInput('nope') === null);
  check('parseInput: null → null', parseInput(null) === null);
  check('parseInput: missing taskId → null', parseInput({ title: 't' }) === null);
  check('parseInput: missing title → null', parseInput({ taskId: 't' }) === null);

  const minimal = parseInput({ taskId: 't1', title: 'Do it' });
  check('parseInput: a valid minimal payload normalizes', minimal !== null);
  check('parseInput: intent defaults to ""', minimal?.intent === '');
  check('parseInput: goal defaults to ""', minimal?.goal === '');
  check('parseInput: acceptance defaults to []', Array.isArray(minimal?.acceptance) && minimal?.acceptance.length === 0);

  const mixed = parseInput({
    taskId: 't2',
    title: 'T',
    acceptance: ['keep me', 7, null, 'also me', { x: 1 }],
  });
  check(
    'parseInput: acceptance keeps only the string members',
    !!mixed && mixed.acceptance.length === 2 && mixed.acceptance[0] === 'keep me' && mixed.acceptance[1] === 'also me',
  );
}

function testFirstJsonObject(): void {
  const bare = firstJsonObject('{"a":1,"b":"two"}');
  check('firstJsonObject: a bare object parses', !!bare && bare.a === 1 && bare.b === 'two');

  const prosed = firstJsonObject('Here is the result you asked for:\n{"ok":true}\nThanks!');
  check('firstJsonObject: an object preceded by prose parses', !!prosed && prosed.ok === true);

  // A brace INSIDE a JSON string value must not throw off depth tracking — the
  // object closes at its real terminator, not the brace in the string.
  const braceInStr = firstJsonObject('{"note":"a } brace { inside","done":true}');
  check(
    'firstJsonObject: a brace inside a string value does not break depth tracking',
    !!braceInStr && braceInStr.note === 'a } brace { inside' && braceInStr.done === true,
  );

  check('firstJsonObject: malformed JSON → null', firstJsonObject('{"a": }') === null);
  check('firstJsonObject: text with no brace → null', firstJsonObject('nothing to see here') === null);
  // Opened but never balanced: the scanner must fall through to null, never a partial slice.
  check('firstJsonObject: an unterminated object → null', firstJsonObject('prefix {"a":1 and never closes') === null);
}

function testExtractArtifacts(): void {
  const fenced = extractArtifacts(
    'Report text.\n```json\n{"artifacts":[{"path":"src/a.ts","label":"the main file"}]}\n```',
  );
  check(
    'extractArtifacts: a fenced json block yields its artifacts',
    fenced.length === 1 && fenced[0].path === 'src/a.ts' && fenced[0].label === 'the main file',
  );

  const unfenced = extractArtifacts('{"artifacts":[{"path":"plain.ts"}]}');
  check(
    'extractArtifacts: an unfenced json object is scanned (fallback)',
    unfenced.length === 1 && unfenced[0].path === 'plain.ts' && unfenced[0].label === undefined,
  );

  // Several fenced blocks: the FIRST with a valid artifacts array wins.
  const multi = extractArtifacts(
    '```json\n{"notArtifacts":[1,2,3]}\n```\n```json\n{"artifacts":[{"path":"winner.ts"}]}\n```\n```json\n{"artifacts":[{"path":"loser.ts"}]}\n```',
  );
  check(
    'extractArtifacts: first fenced block with a valid artifacts array wins',
    multi.length === 1 && multi[0].path === 'winner.ts',
  );

  const cleaned = extractArtifacts(
    '```json\n{"artifacts":[{"path":"keep.ts"},{"path":""},{"path":"   "},{"path":"   trimmed.ts   "},42,null,"str",{"label":"no path"}]}\n```',
  );
  check(
    'extractArtifacts: drops missing/empty paths, skips non-object items, trims paths',
    cleaned.length === 2 && cleaned[0].path === 'keep.ts' && cleaned[1].path === 'trimmed.ts',
  );

  check('extractArtifacts: returns [] when nothing matches', extractArtifacts('no json at all here').length === 0);
}

function testResolveOutputs(workspace: string): void {
  check('resolveOutputs: null root → []', resolveOutputs(null, [{ path: 'real.txt' }]).length === 0);

  // ── one real file inside root → ONE Resource ────────────────────────────────
  writeFileSync(path.join(workspace, 'real.txt'), 'hello');
  const one = resolveOutputs(workspace, [{ path: 'real.txt', label: 'My File' }]);
  check('resolveOutputs: a real in-root file resolves to ONE Resource', one.length === 1);
  check('resolveOutputs: kind is "code"', one[0]?.kind === 'code');
  check('resolveOutputs: uri is a file:// URL', one[0]?.uri.startsWith('file://') === true);
  check('resolveOutputs: uri points at the real file', relOf(workspace, one[0]) === 'real.txt');
  check('resolveOutputs: label uses artifact.label when present', one[0]?.label === 'My File');

  const noLabel = resolveOutputs(workspace, [{ path: 'real.txt' }]);
  check('resolveOutputs: label falls back to artifact.path', noLabel[0]?.label === 'real.txt');

  // ── traversal / absolute paths are rejected ────────────────────────────────
  writeFileSync(path.join(path.dirname(workspace), 'escaped.txt'), 'outside');
  check(
    'resolveOutputs: a "../" path that escapes root is rejected',
    resolveOutputs(workspace, [{ path: '../escaped.txt' }]).length === 0,
  );
  check(
    'resolveOutputs: an absolute path is rejected',
    resolveOutputs(workspace, [{ path: path.join(workspace, 'real.txt') }]).length === 0,
  );

  // ── directories, missing files are skipped ─────────────────────────────────
  mkdirSync(path.join(workspace, 'adir'));
  check('resolveOutputs: a directory (not a file) is skipped', resolveOutputs(workspace, [{ path: 'adir' }]).length === 0);
  check('resolveOutputs: a missing file is skipped', resolveOutputs(workspace, [{ path: 'ghost.txt' }]).length === 0);

  // ── duplicate paths dedupe to one ──────────────────────────────────────────
  const dup = resolveOutputs(workspace, [{ path: 'real.txt' }, { path: 'real.txt' }, { path: './real.txt' }]);
  check('resolveOutputs: duplicate paths dedupe to one Resource', dup.length === 1);

  // ── MAX_OUTPUTS cap (8) ────────────────────────────────────────────────────
  const many: { path: string }[] = [];
  for (let i = 0; i < 12; i += 1) {
    const name = `cap-${i}.txt`;
    writeFileSync(path.join(workspace, name), String(i));
    many.push({ path: name });
  }
  check('resolveOutputs: more than MAX_OUTPUTS distinct files are capped at 8', resolveOutputs(workspace, many).length === 8);

  // ── symlink rejection (best-effort: Windows often EPERM without Dev Mode) ───
  let symlinkCreated = false;
  const linkPath = path.join(workspace, 'link.txt');
  try {
    symlinkSync(path.join(workspace, 'real.txt'), linkPath, 'file');
    symlinkCreated = true;
  } catch {
    console.log('  (skip) symlink rejection: could not create a symlink (EPERM — no Developer Mode)');
  }
  if (symlinkCreated) {
    check('resolveOutputs: a symlink is rejected', resolveOutputs(workspace, [{ path: 'link.txt' }]).length === 0);
  }
}

function testStripJsonFences(): void {
  const text = 'Here is what I found.\n\n```json\n{"artifacts":[{"path":"x.ts"}]}\n```';
  check('stripJsonFences: removes the fenced json block and trims', stripJsonFences(text) === 'Here is what I found.');
  check('stripJsonFences: leaves ordinary prose intact', stripJsonFences('just prose, no fence') === 'just prose, no fence');
}

async function testRunTaskEarlyReturns(): Promise<void> {
  const invalid = await runTask('nope');
  check('runTask: invalid payload → ok:false', invalid.ok === false);
  check(
    'runTask: invalid payload reason is "Invalid task payload."',
    invalid.ok === false && invalid.reason === 'Invalid task payload.',
  );

  // Valid shape but no title AND no intent → early return before provider resolution.
  const empty = await runTask({ taskId: 't', title: '', intent: '' });
  check('runTask: no title or intent → ok:false (before any provider resolution)', empty.ok === false);
}

function testImplementPrompt(): void {
  const input = parseInput({
    taskId: 't1',
    title: 'Add the orders endpoint',
    intent: 'expose orders over HTTP',
    goal: 'ship orders',
    acceptance: ['endpoint returns 200'],
  });
  check('implementPrompt: fixture payload parses', input !== null);
  if (!input) return;

  // With folded workspace instructions, the child's seed carries the repo's own
  // conventions (the FIX: the implement child should see AGENTS.md like the parent).
  const folded = implementPrompt(
    input,
    "The user's repository ships instruction file(s). (AGENTS.md)\nTypeScript stays strict. No any.",
  );
  check('implementPrompt: the task title is present', folded.includes('Add the orders endpoint'));
  check('implementPrompt: the acceptance criterion is present', folded.includes('endpoint returns 200'));
  check(
    'implementPrompt: the folded workspace conventions are included',
    folded.includes('TypeScript stays strict. No any.'),
  );

  // Empty instructions ('' — no AGENTS.md present) must not add a dangling block.
  const bare = implementPrompt(input, '');
  check('implementPrompt: empty instructions adds no conventions block', !bare.includes('repository ships'));
  check('implementPrompt: bare prompt still carries the task', bare.includes('Add the orders endpoint'));
}

/** Build a stub diagnostics run that errors on `errorFiles` (empty = clean pass). */
function diagRun(errorFiles: string[], exitCode: number | null = errorFiles.length ? 1 : 0): DiagnosticsRun {
  const diagnostics: Diagnostic[] = errorFiles.map((file) => ({
    file,
    line: 1,
    column: 1,
    severity: 'error' as const,
    message: `Type error in ${file}`,
    source: 'tsc',
  }));
  return { checkerId: 'tsc', command: 'tsc --noEmit', exitCode, durationMs: 1, diagnostics, truncated: false };
}

async function testProbeChangedFiles(): Promise<void> {
  // No checker applied (exitCode null) → null (honestly unverified).
  check(
    'probeChangedFiles: no checker applied → null',
    (await probeChangedFiles(async () => ({ lastRun: diagRun([], null) }), '/wt', ['a.ts'])) === null,
  );
  // A clean pass → empty errors list (not null).
  const clean = await probeChangedFiles(async () => ({ lastRun: diagRun([]) }), '/wt', ['a.ts']);
  check('probeChangedFiles: clean pass → zero errors', !!clean && clean.errors.length === 0);
  // An error on a CHANGED file is reported.
  const onChanged = await probeChangedFiles(async () => ({ lastRun: diagRun(['a.ts']) }), '/wt', ['a.ts']);
  check('probeChangedFiles: error on a changed file is reported', !!onChanged && onChanged.errors.length === 1);
  // An error on an UNCHANGED file is ignored (pre-existing repo error, not ours).
  const onOther = await probeChangedFiles(async () => ({ lastRun: diagRun(['other.ts']) }), '/wt', ['a.ts']);
  check('probeChangedFiles: error on an unchanged file is ignored', !!onOther && onOther.errors.length === 0);
  // Backslash paths normalize to POSIX before comparison.
  const win = await probeChangedFiles(async () => ({ lastRun: diagRun(['src/a.ts']) }), '/wt', ['src\\a.ts']);
  check('probeChangedFiles: changed-file paths normalize across slash styles', !!win && win.errors.length === 1);
}

function testVerifyNoteFor(): void {
  check('verifyNoteFor: undefined → unverified note', verifyNoteFor(undefined, 0) === 'no checker applied — left unverified');
  check('verifyNoteFor: true → clean note', verifyNoteFor(true, 0) === 'verified: no errors on changed files');
  check('verifyNoteFor: false singular', verifyNoteFor(false, 1) === '1 error remain on changed files');
  check('verifyNoteFor: false plural', verifyNoteFor(false, 3) === '3 errors remain on changed files');
}

async function testVerifyFixLoop(): Promise<void> {
  // ── clean first pass → no fix turn, verified true ───────────────────────────
  let fixTurns = 0;
  const cleanOutcome = await runVerifyFixLoop({
    root: '/wt',
    changedFiles: ['a.ts'],
    runDiag: async () => ({ lastRun: diagRun([]) }),
    restage: async () => ['a.ts'],
    runFixTurn: async () => {
      fixTurns += 1;
    },
    remainingMs: () => 120_000,
  });
  check('verifyFixLoop: a clean first pass runs NO fix turn', fixTurns === 0);
  check('verifyFixLoop: a clean first pass is verified:true', cleanOutcome.verified === true);

  // ── error, then a fix turn CLEARS it → exactly one fix turn, verified true ───
  fixTurns = 0;
  let seededWith = '';
  const probes = [diagRun(['a.ts']), diagRun([])]; // 1st probe: error; after fix: clean
  let probeIdx = 0;
  const fixedOutcome = await runVerifyFixLoop({
    root: '/wt',
    changedFiles: ['a.ts'],
    runDiag: async () => {
      const run = probes[Math.min(probeIdx, probes.length - 1)];
      probeIdx += 1;
      return { lastRun: run };
    },
    restage: async () => ['a.ts'],
    runFixTurn: async (seed) => {
      fixTurns += 1;
      seededWith = seed;
    },
    remainingMs: () => 120_000,
  });
  check('verifyFixLoop: an error triggers exactly one fix turn', fixTurns === 1);
  check('verifyFixLoop: the fix turn is seeded with the exact diagnostic', seededWith.includes('Type error in a.ts'));
  check('verifyFixLoop: a cleared error ends verified:true', fixedOutcome.verified === true);
  check('verifyFixLoop: no remaining errors when cleared', fixedOutcome.remainingErrors.length === 0);

  // ── error that PERSISTS past the cap → verified false, honest remaining count ─
  fixTurns = 0;
  const persistOutcome = await runVerifyFixLoop({
    root: '/wt',
    changedFiles: ['a.ts'],
    runDiag: async () => ({ lastRun: diagRun(['a.ts']) }), // never clears
    restage: async () => ['a.ts'],
    runFixTurn: async () => {
      fixTurns += 1;
    },
    remainingMs: () => 120_000,
  });
  check('verifyFixLoop: a persistent error is capped at MAX_VERIFY_FIX (1) fix turn', fixTurns === 1);
  check('verifyFixLoop: a persistent error ends verified:false (never faked green)', persistOutcome.verified === false);
  check('verifyFixLoop: verified:false reports the honest remaining count', persistOutcome.remainingErrors.length === 1);

  // ── budget guard: no time left → no fix turn even with an error ──────────────
  fixTurns = 0;
  const budgetOutcome = await runVerifyFixLoop({
    root: '/wt',
    changedFiles: ['a.ts'],
    runDiag: async () => ({ lastRun: diagRun(['a.ts']) }),
    restage: async () => ['a.ts'],
    runFixTurn: async () => {
      fixTurns += 1;
    },
    remainingMs: () => 1_000, // below VERIFY_FIX_MIN_REMAINING_MS
  });
  check('verifyFixLoop: a near-exhausted budget skips the fix turn', fixTurns === 0);
  check('verifyFixLoop: budget-skipped error still ends verified:false', budgetOutcome.verified === false);

  // ── no checker applies → honestly unverified, no fix turn ────────────────────
  fixTurns = 0;
  const unverified = await runVerifyFixLoop({
    root: '/wt',
    changedFiles: ['a.ts'],
    runDiag: async () => ({ lastRun: diagRun([], null) }),
    restage: async () => ['a.ts'],
    runFixTurn: async () => {
      fixTurns += 1;
    },
    remainingMs: () => 120_000,
  });
  check('verifyFixLoop: no applicable checker → verified undefined', unverified.verified === undefined);
  check('verifyFixLoop: no applicable checker → no fix turn', fixTurns === 0);

  // ── the loop RETURNS its final changedFiles (caller need not re-stage) ────────
  let restageCalls = 0;
  const returnsFiles = await runVerifyFixLoop({
    root: '/wt',
    changedFiles: ['a.ts'],
    runDiag: async () => ({ lastRun: diagRun([]) }), // clean first pass → no fix turn
    restage: async () => {
      restageCalls += 1;
      return ['fix.ts'];
    },
    runFixTurn: async () => undefined,
    remainingMs: () => 120_000,
  });
  check('verifyFixLoop: a clean first pass returns its initial changedFiles', returnsFiles.changedFiles.length === 1 && returnsFiles.changedFiles[0] === 'a.ts');
  // A clean first pass must NOT re-stage at all — the implement turn already staged.
  check('verifyFixLoop: a clean first pass does NOT re-stage (no double round-trip)', restageCalls === 0);

  // The error→fix path returns the RE-STAGED list (post-fix), exactly once.
  restageCalls = 0;
  const probeSeq = [diagRun(['a.ts']), diagRun([])];
  let pIdx = 0;
  const refreshed = await runVerifyFixLoop({
    root: '/wt',
    changedFiles: ['a.ts'],
    runDiag: async () => {
      const run = probeSeq[Math.min(pIdx, probeSeq.length - 1)];
      pIdx += 1;
      return { lastRun: run };
    },
    restage: async () => {
      restageCalls += 1;
      return ['a.ts', 'b.ts'];
    },
    runFixTurn: async () => undefined,
    remainingMs: () => 120_000,
  });
  check('verifyFixLoop: a fix turn returns the RE-STAGED changedFiles', refreshed.changedFiles.length === 2 && refreshed.changedFiles.includes('b.ts'));
  check('verifyFixLoop: exactly one re-stage after the single fix turn', restageCalls === 1);

  // ── staging FAILURE before the loop → verified UNDEFINED, never true ──────────
  fixTurns = 0;
  const stageFailedFirst = await runVerifyFixLoop({
    root: '/wt',
    changedFiles: null, // initial stage threw → restage returned null
    runDiag: async () => ({ lastRun: diagRun([]) }),
    restage: async () => null,
    runFixTurn: async () => {
      fixTurns += 1;
    },
    remainingMs: () => 120_000,
  });
  check('verifyFixLoop: an initial staging failure is verified:undefined (NOT true)', stageFailedFirst.verified === undefined);
  check('verifyFixLoop: an initial staging failure runs no fix turn', fixTurns === 0);
  check('verifyFixLoop: an initial staging failure reports no changedFiles', stageFailedFirst.changedFiles.length === 0);

  // ── staging FAILURE mid-loop (after the fix turn) → verified UNDEFINED ────────
  fixTurns = 0;
  const stageFailedMid = await runVerifyFixLoop({
    root: '/wt',
    changedFiles: ['a.ts'],
    runDiag: async () => ({ lastRun: diagRun(['a.ts']) }), // error triggers a fix turn
    restage: async () => null, // re-stage after the fix turn throws
    runFixTurn: async () => {
      fixTurns += 1;
    },
    remainingMs: () => 120_000,
  });
  check('verifyFixLoop: a mid-loop staging failure is verified:undefined (never faked green)', stageFailedMid.verified === undefined);
  check('verifyFixLoop: a mid-loop staging failure still ran the fix turn', fixTurns === 1);
}

/**
 * The worktree probe must respect the run deadline: runDiagnostics aborts before
 * the next checker when the injected signal is already aborted. probeChangedFiles
 * delegates to runDiag, so an aborted-signal probe yields a no-applicable-checker
 * result (exitCode stays null) rather than self-bounding for the full TIMEOUT_MS.
 */
async function testProbeRespectsAbort(): Promise<void> {
  const ac = new AbortController();
  ac.abort();
  // Stub runDiag the way implementTask wires it: it forwards the aborted signal to
  // the checker, which bails immediately with exitCode null.
  let checkerSpawned = false;
  const runDiag = async (): Promise<{ lastRun: DiagnosticsRun }> => {
    if (ac.signal.aborted) {
      // mirrors runDiagnostics: aborted → no checker leg runs → exitCode null
      return { lastRun: diagRun([], null) };
    }
    checkerSpawned = true;
    return { lastRun: diagRun(['a.ts']) };
  };
  const probe = await probeChangedFiles(runDiag, '/wt', ['a.ts']);
  check('probe(abort): an aborted signal makes the probe bail (no checker spawned)', checkerSpawned === false);
  check('probe(abort): an aborted-signal probe is honestly unverified (null)', probe === null);
}

async function main(): Promise<void> {
  // workspace is a child dir so a "../escaped.txt" fixture can live OUTSIDE it.
  const base = mkdtempSync(path.join(tmpdir(), 'run-task-harness-'));
  const workspace = path.join(base, 'ws');
  mkdirSync(workspace);
  try {
    testParseInput();
    testFirstJsonObject();
    testExtractArtifacts();
    testResolveOutputs(workspace);
    testStripJsonFences();
    testImplementPrompt();
    await testRunTaskEarlyReturns();
    await testProbeChangedFiles();
    testVerifyNoteFor();
    await testVerifyFixLoop();
    await testProbeRespectsAbort();

    console.log(`\nrun-task harness: ${passedCount()} assertions passed`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('run-task harness FAILED:', err);
  process.exitCode = 1;
});
