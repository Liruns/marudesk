import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import type {
  GitAvailability,
  GitBranches,
  GitCommit,
  GitCommitResult,
  GitRemoteResult,
  GitStatus,
} from '../shared/git';
import { isSshRootKey } from '../shared/ssh';
import { resolveWorkspacePath } from './fs-safe';
import { defineHandler, requireWorkspace } from './ipc/define-handler';
import { arrayOf, bool, obj, str } from './ipc/validate';
import { readFileSafe } from './workspace';
import { parseBranchHeaders, parseStatus, summarize } from './git-parse';
import {
  discardIsolation,
  enterIsolation,
  isolationStatus,
  mergeIsolation,
} from './worktree-isolation';

/**
 * Workspace Source Control (VSCode-style). Every command runs against the open
 * workspace root via execFile — argv arrays only, never a shell — so a path or
 * branch name with spaces/metacharacters can never be interpreted as a command.
 * Mirrors electron/workspace.ts's `git ls-files` invocation (same buffer cap).
 *
 * `status` deliberately returns { isRepo: false } instead of throwing when the
 * folder isn't a repo, so the panel can offer "initialize repository?". The
 * destructive op (discard) restores the working tree / deletes untracked files
 * — the renderer confirms before calling. No remote op ever uses --force.
 */

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 64 * 1024 * 1024;
const FAST_TIMEOUT = 10_000;
// Network ops (fetch/pull/push) can be slow on a cold remote; give them room.
const SLOW_TIMEOUT = 60_000;
const LOG_MAX = 50;

/** Run a git subcommand in the workspace root. Resolves { stdout, stderr }. */
async function git(
  root: string,
  args: string[],
  timeout = FAST_TIMEOUT,
): Promise<{ stdout: string; stderr: string }> {
  // Source Control runs git against a local checkout; a remote (ssh://) root has
  // no local path to `-C` into. Fail clearly instead of spawning git with an
  // invalid cwd. (Remote indexing uses git over SSH in electron/ssh/*.)
  if (isSshRootKey(root)) {
    throw new Error('Source Control is not available for remote (SSH) workspaces');
  }
  return execFileAsync('git', ['-C', root, ...args], {
    cwd: root,
    maxBuffer: MAX_BUFFER,
    timeout,
    // Keep porcelain output stable + English regardless of the user's locale.
    // GIT_TERMINAL_PROMPT=0: execFile has no TTY, so a remote that needs creds
    // would hang until the timeout — fail fast instead (a configured credential
    // helper / SSH agent still authenticates non-interactively).
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

/**
 * Whether a usable `git` binary is on PATH. A positive result is cached (PATH
 * rarely loses git mid-session); a negative one is NOT, so installing git and
 * reopening Source Control recovers without restarting marudesk.
 */
let gitInstalled: GitAvailability | null = null;
/**
 * Shared git runner for sibling main-process modules (e.g. git-worktree.ts) so
 * worktree commands inherit the SAME hardening as Source Control: argv-only (no
 * shell), the SSH-root guard, the locale/lock/credential env, and the buffer cap.
 */
export function runGit(
  root: string,
  args: string[],
  timeout = FAST_TIMEOUT,
): Promise<{ stdout: string; stderr: string }> {
  return git(root, args, timeout);
}
async function checkGitAvailable(): Promise<GitAvailability> {
  if (gitInstalled) return gitInstalled;
  try {
    const { stdout } = await execFileAsync('git', ['--version'], {
      timeout: FAST_TIMEOUT,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    gitInstalled = {
      installed: true,
      version: stdout.trim().replace(/^git version\s*/i, ''),
    };
    return gitInstalled;
  } catch {
    // ENOENT (no git) or any other failure → report missing; don't cache so a
    // later install is picked up on the next check.
    return { installed: false };
  }
}

/** True when the workspace root is inside a git work tree. */
async function isRepo(root: string): Promise<boolean> {
  try {
    const { stdout } = await git(root, [
      'rev-parse',
      '--is-inside-work-tree',
    ]);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Validate + normalize a batch of workspace-relative paths from the renderer.
 * Routes each through resolveWorkspacePath (rejects absolute / '..' / null-byte
 * / ':' ) so a crafted path can never escape the workspace, then returns the
 * canonical relative POSIX form git expects after the `--` separator.
 */
function safePaths(root: string, value: unknown): string[] {
  const raw = arrayOf(value, (x, i) => str(x, `paths[${i}]`), 'paths');
  if (raw.length === 0) throw new Error('no paths given');
  return raw.map((p) => resolveWorkspacePath(root, p).rel);
}



async function getStatus(root: string): Promise<GitStatus> {
  if (!(await isRepo(root))) return { isRepo: false };
  // Porcelain v1 with -z: NUL-delimited records, rename old-path as its own
  // trailing record. --branch prepends the "## ..." header record(s).
  const { stdout } = await git(root, [
    'status',
    '--porcelain=v1',
    '--branch',
    '-z',
    '--untracked-files=all',
  ]);
  const records = stdout.split('\0').filter((r) => r.length > 0);
  const headers = records.filter((r) => r.startsWith('##'));
  const fileRecords = records.filter((r) => !r.startsWith('##'));
  const { branch, upstream, ahead, behind, unborn } =
    parseBranchHeaders(headers);
  const files = parseStatus(fileRecords);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { isRepo: true, branch, upstream, ahead, behind, unborn, files };
}

async function getLog(root: string): Promise<GitCommit[]> {
  if (!(await isRepo(root))) return [];
  // Unit-separator (\x1f) between fields, record-separator (\x1e) between
  // commits — neither appears in commit text, so parsing is unambiguous.
  const fmt = ['%H', '%h', '%s', '%an', '%cr'].join('%x1f');
  try {
    const { stdout } = await git(root, [
      'log',
      `--max-count=${LOG_MAX}`,
      `--pretty=format:${fmt}%x1e`,
    ]);
    const out: GitCommit[] = [];
    for (const rec of stdout.split('\x1e')) {
      const line = rec.replace(/^\n/, '');
      if (!line) continue;
      const [hash, shortHash, subject, author, relDate] = line.split('\x1f');
      if (!hash) continue;
      out.push({ hash, shortHash, subject, author, relDate });
    }
    return out;
  } catch {
    // Unborn branch (no commits yet) — `git log` exits non-zero; that's fine.
    return [];
  }
}

async function getBranches(root: string): Promise<GitBranches> {
  if (!(await isRepo(root))) return { current: null, branches: [] };
  const { stdout } = await git(root, [
    'branch',
    '--list',
    '--format=%(refname:short)',
  ]);
  const branches = stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  let current: string | null;
  try {
    const { stdout: cur } = await git(root, ['symbolic-ref', '--short', 'HEAD']);
    current = cur.trim() || null;
  } catch {
    current = null; // detached HEAD
  }
  return { current, branches };
}

async function getDiff(
  root: string,
  rel: string,
  staged: boolean,
): Promise<string> {
  const { rel: safeRel } = resolveWorkspacePath(root, rel);
  const args = ['diff'];
  if (staged) args.push('--cached');
  // `-- <path>` keeps the pathspec from being parsed as a flag/revision.
  args.push('--', safeRel);
  const { stdout } = await git(root, args);
  if (stdout.length > 0) return stdout;
  // An untracked file produces no `git diff` output (git doesn't know it).
  // Synthesize an all-additions unified diff from its content rather than
  // relying on `git diff --no-index` against /dev/null|NUL, which behaves
  // inconsistently with `-C <root>` on Windows. readFileSafe size-caps + is
  // symlink-safe; a binary file is reported as such instead of dumped.
  if (!staged) {
    return synthesizeUntrackedDiff(root, safeRel);
  }
  return '';
}

/** Build an all-additions unified diff for an untracked file from its bytes. */
async function synthesizeUntrackedDiff(
  root: string,
  rel: string,
): Promise<string> {
  let content: string;
  try {
    content = await readFileSafe(root, rel);
  } catch {
    return '';
  }
  if (content.includes('\0')) {
    return `diff --git a/${rel} b/${rel}\nBinary file (untracked) — no preview.\n`;
  }
  const lines = content.length === 0 ? [] : content.replace(/\n$/, '').split('\n');
  const header =
    `diff --git a/${rel} b/${rel}\n` +
    `new file\n` +
    `--- /dev/null\n` +
    `+++ b/${rel}\n` +
    `@@ -0,0 +1,${lines.length} @@\n`;
  return header + lines.map((l) => `+${l}`).join('\n') + (lines.length ? '\n' : '');
}

async function commit(
  root: string,
  message: string,
  amend: boolean,
): Promise<GitCommitResult> {
  const msg = message.trim();
  if (msg.length === 0) throw new Error('commit message must not be empty');
  const args = ['commit', '-m', msg];
  if (amend) args.push('--amend');
  await git(root, args);
  // Report the new HEAD so the renderer can confirm + refresh.
  const { stdout } = await git(root, ['log', '-1', '--pretty=format:%h%x1f%s']);
  const [shortHash, subject] = stdout.split('\x1f');
  return { shortHash: shortHash ?? '', subject: subject ?? msg };
}

/** Restore working-tree changes / delete untracked files for the given paths. */
async function discard(root: string, paths: string[]): Promise<void> {
  const status = await getStatus(root);
  if (!status.isRepo) throw new Error('not a git repository');
  const byPath = new Map(status.files.map((f) => [f.path, f]));
  const untracked: string[] = [];
  const tracked: string[] = [];
  for (const p of paths) {
    const change = byPath.get(p);
    if (change?.untracked) untracked.push(p);
    else tracked.push(p);
  }
  // Tracked: discard worktree edits (and unstage) via `checkout -- <paths>`.
  if (tracked.length > 0) {
    await git(root, ['checkout', '--', ...tracked]);
  }
  // Untracked: there's nothing in git to restore — delete the file outright.
  // Each path was resolved through resolveWorkspacePath by safePaths(), so it
  // is guaranteed inside the workspace; re-resolve to get the absolute path.
  for (const p of untracked) {
    const { abs } = resolveWorkspacePath(root, p);
    await fs.rm(abs, { force: true, recursive: false }).catch(() => {
      // best-effort: a vanished file is already "discarded"
    });
  }
}

/** Summarize a remote op's output, falling back to a generic done message. */

async function remote(
  root: string,
  op: 'fetch' | 'pull' | 'push',
): Promise<GitRemoteResult> {
  const status = await getStatus(root);
  if (!status.isRepo) throw new Error('not a git repository');
  // pull/push need an upstream to target; surface a clear error rather than
  // git's terser one. fetch with no upstream still works (fetches the default
  // remote), so only gate pull/push.
  if ((op === 'pull' || op === 'push') && !status.upstream) {
    throw new Error('no upstream configured for the current branch');
  }
  try {
    // Bare op — runs against the configured upstream/remote. NEVER --force.
    const { stdout, stderr } = await git(root, [op], SLOW_TIMEOUT);
    return { ok: true, summary: summarize(stdout, stderr, `${op} complete`) };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = (e.stderr || e.message || '').trim();
    throw new Error(detail || `${op} failed`, { cause: err });
  }
}

export function registerGitHandlers(): void {
  // Probes PATH for a git binary — needs no workspace, unlike every op below.
  defineHandler('git:available', () => checkGitAvailable());

  defineHandler('git:status', () => getStatus(requireWorkspace().root));

  defineHandler('git:init', async () => {
    await git(requireWorkspace().root, ['init']);
    return { ok: true } as const;
  });

  defineHandler('git:stage', async ([payload]) => {
    const root = requireWorkspace().root;
    const paths = safePaths(root, obj(payload).paths);
    await git(root, ['add', '--', ...paths]);
    return { ok: true } as const;
  });

  defineHandler('git:stageAll', async () => {
    await git(requireWorkspace().root, ['add', '-A']);
    return { ok: true } as const;
  });

  defineHandler('git:unstage', async ([payload]) => {
    const root = requireWorkspace().root;
    const paths = safePaths(root, obj(payload).paths);
    // `reset -q HEAD -- <paths>` moves them back to the worktree, untouched.
    await git(root, ['reset', '-q', 'HEAD', '--', ...paths]);
    return { ok: true } as const;
  });

  defineHandler('git:discard', async ([payload]) => {
    const root = requireWorkspace().root;
    const paths = safePaths(root, obj(payload).paths);
    await discard(root, paths);
    return { ok: true } as const;
  });

  defineHandler('git:diff', ([payload]) => {
    const p = obj(payload);
    const root = requireWorkspace().root;
    return getDiff(root, str(p.path, 'path'), bool(p.staged, 'staged')).then(
      (diff) => ({ diff }),
    );
  });

  defineHandler('git:commit', ([payload]) => {
    const p = obj(payload);
    const amend = p.amend === undefined ? false : bool(p.amend, 'amend');
    return commit(requireWorkspace().root, str(p.message, 'message'), amend);
  });

  defineHandler('git:branches', () => getBranches(requireWorkspace().root));

  defineHandler('git:checkout', async ([payload]) => {
    const name = str(obj(payload).name, 'name');
    // `--` separates the ref from any pathspec; checkout treats a bare name as
    // a branch switch. argv array means the name is never shell-parsed.
    await git(requireWorkspace().root, ['checkout', name]);
    return { ok: true } as const;
  });

  defineHandler('git:createBranch', async ([payload]) => {
    const p = obj(payload);
    const name = str(p.name, 'name');
    const checkout = p.checkout === undefined ? true : bool(p.checkout, 'checkout');
    const root = requireWorkspace().root;
    if (checkout) await git(root, ['checkout', '-b', name]);
    else await git(root, ['branch', name]);
    return { ok: true } as const;
  });

  defineHandler('git:log', () => getLog(requireWorkspace().root));

  defineHandler('git:fetch', () => remote(requireWorkspace().root, 'fetch'));
  defineHandler('git:pull', () => remote(requireWorkspace().root, 'pull'));
  defineHandler('git:push', () => remote(requireWorkspace().root, 'push'));

  // Worktree isolation (Stage 12-B): drive the agent's isolated worktree for the
  // active workspace. The lifecycle/state lives in worktree-isolation.ts.
  defineHandler('git:worktree-status', () => isolationStatus(requireWorkspace().root));
  defineHandler('git:worktree-enter', () => enterIsolation(requireWorkspace().root));
  defineHandler('git:worktree-merge', () => mergeIsolation(requireWorkspace().root));
  defineHandler('git:worktree-discard', async () => {
    await discardIsolation(requireWorkspace().root);
    return { ok: true } as const;
  });
}
