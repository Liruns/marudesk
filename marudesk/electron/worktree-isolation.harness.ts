import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  configureWorktreeIsolation,
  discardIsolation,
  effectiveAgentRoot,
  enterIsolation,
  getIsolation,
  isolationStatus,
  mergeIsolation,
  parseIsolationState,
  serializeIsolationState,
  __resetWorktreeIsolationForTests,
} from './worktree-isolation.ts';

/**
 * Harness for Stage 12-B-1 worktree isolation: pure (de)serialization + the full
 * lifecycle (enter → effective-root routing → changes/persist → merge / discard)
 * against a REAL temp git repo. Headless — run via `npm run harness:worktree-iso`.
 */

const exec = promisify(execFile);
let passed = 0;
function check(label: string, cond: boolean): void {
  assert.ok(cond, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}
async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', root, ...args], { env: { ...process.env, LC_ALL: 'C' } });
  return stdout;
}

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'iso-repo-'));
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'h@e.com']);
  await git(dir, ['config', 'user.name', 'H']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(dir, 'app.txt'), 'one\ntwo\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'init']);
  return dir;
}

async function main(): Promise<void> {
  /* ── pure (de)serialization ───────────────────────────────────────────── */
  {
    const map = new Map([
      ['/r', { root: '/r', worktreePath: '/wt', branch: 'marudesk/agent/1', createdAt: 5 }],
    ]);
    const round = parseIsolationState(JSON.parse(serializeIsolationState(map)));
    check('serialize/parse round-trips one entry', round.get('/r')?.branch === 'marudesk/agent/1');
    const junk = parseIsolationState({ entries: [{ root: 1 }, null, { root: '/x', worktreePath: '/y', branch: '' }] });
    check('parse drops malformed/blank entries', junk.size === 0);
    check('parse tolerates a non-object', parseIsolationState('nope').size === 0);
  }

  const stateFile = path.join(mkdtempSync(path.join(tmpdir(), 'iso-state-')), 'state.json');
  const worktreesDir = mkdtempSync(path.join(tmpdir(), 'iso-wts-'));
  const repo = await makeRepo();
  try {
    __resetWorktreeIsolationForTests();
    await configureWorktreeIsolation({ stateFile, worktreesDir });

    /* ── enter isolation ──────────────────────────────────────────────────── */
    check('effectiveAgentRoot is the repo itself before isolation', effectiveAgentRoot(repo) === repo);
    const entered = await enterIsolation(repo);
    check('enter: status is active on an agent branch', entered.active === true && entered.branch.startsWith('marudesk/agent/'));
    const iso = getIsolation(repo)!;
    check('enter: a worktree dir was created under worktreesDir', existsSync(iso.worktreePath) && iso.worktreePath.startsWith(worktreesDir));
    check('effectiveAgentRoot now routes to the worktree', effectiveAgentRoot(repo) === iso.worktreePath);
    check('enter: state was persisted', parseIsolationState(JSON.parse(readFileSync(stateFile, 'utf8'))).has(path.resolve(repo)));
    check('enter is idempotent (no second worktree)', (await enterIsolation(repo)).active === true);

    /* ── edit in the worktree → changes reflected ─────────────────────────── */
    writeFileSync(path.join(iso.worktreePath, 'app.txt'), 'one\nISOLATED\n');
    const status = await isolationStatus(repo);
    check('status: pending change counted', status.active === true && status.changes.count === 1);
    check('main tree is untouched while isolated', readFileSync(path.join(repo, 'app.txt'), 'utf8') === 'one\ntwo\n');

    /* ── merge back ───────────────────────────────────────────────────────── */
    const merged = await mergeIsolation(repo);
    check('merge: ok', merged.ok === true);
    check('merge: main now has the isolated edit', readFileSync(path.join(repo, 'app.txt'), 'utf8') === 'one\nISOLATED\n');
    check('merge: isolation ended (effective root back to repo)', effectiveAgentRoot(repo) === repo);
    check('merge: persisted state cleared', parseIsolationState(JSON.parse(readFileSync(stateFile, 'utf8'))).size === 0);

    /* ── discard path ─────────────────────────────────────────────────────── */
    const wt2 = await enterIsolation(repo);
    const iso2 = getIsolation(repo)!;
    writeFileSync(path.join(iso2.worktreePath, 'app.txt'), 'one\nTHROWAWAY\n');
    check('discard: re-entered isolation', wt2.active === true);
    await discardIsolation(repo);
    check('discard: effective root back to repo', effectiveAgentRoot(repo) === repo);
    check('discard: worktree dir removed', !existsSync(iso2.worktreePath));
    check('discard: main untouched by the discarded edit', readFileSync(path.join(repo, 'app.txt'), 'utf8') === 'one\nISOLATED\n');

    /* ── restore drops a stale entry on configure ─────────────────────────── */
    writeFileSync(
      stateFile,
      serializeIsolationState(new Map([[path.resolve(repo), { root: path.resolve(repo), worktreePath: path.join(worktreesDir, 'gone'), branch: 'marudesk/agent/x', createdAt: 1 }]])),
    );
    __resetWorktreeIsolationForTests();
    await configureWorktreeIsolation({ stateFile, worktreesDir });
    check('restore: a stale (missing worktree) entry is dropped', getIsolation(repo) === null);

    console.log(`\nworktree-isolation harness: ${passed} assertions passed`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktreesDir, { recursive: true, force: true });
    rmSync(path.dirname(stateFile), { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('worktree-isolation harness FAILED:', err);
  process.exitCode = 1;
});
