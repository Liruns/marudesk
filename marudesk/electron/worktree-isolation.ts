import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { atomicWriteFile } from './fs-safe';
import {
  createWorktree,
  discardWorktree,
  isGitRepo,
  listWorktrees,
  agentBranchName,
  mergeWorktree,
  worktreeChanges,
} from './git-worktree';
import type {
  WorktreeChanges,
  WorktreeIsolationStatus,
  WorktreeMergeResult,
} from '../shared/worktree';

/**
 * Worktree isolation lifecycle (Stage 12-B). A workspace can run the agent in a
 * dedicated git worktree on an isolated branch: the agent's effective root is
 * swapped to the worktree, so its file edits / run_command / diagnostics happen
 * there, then merge back into the base branch or discard as a unit.
 *
 * Isolation is keyed per (THREAD, repo root) — Stage 12-B-2: each conversation
 * thread gets its OWN worktree, so concurrent threads on the same repo isolate
 * independently and never collide. The active thread is resolved through an
 * injected accessor (the agent's current conversation id), falling back to a
 * stable default when there's no conversation (e.g. the Source Control panel
 * acting before a chat starts).
 *
 * State is persisted (an in-progress isolated run survives a restart). The
 * decision logic + (de)serialization are pure and headless-tested; only
 * configure + the orchestrator touch git/disk.
 */

/** Thread id used when no conversation is active (panel-driven isolation). */
export const DEFAULT_THREAD = 'default';

/** Separator for the composite (thread, root) map key — a NUL can't appear in either. */
const KEY_SEP = '\u0000';

/** One thread's active isolation, persisted under userData. */
export type IsolationState = {
  /** The conversation thread that owns this worktree. */
  threadId: string;
  /** The main repo root this worktree isolates (normalized absolute path). */
  root: string;
  /** Absolute path of the agent's worktree working directory. */
  worktreePath: string;
  /** The `marudesk/agent/*` branch checked out in the worktree. */
  branch: string;
  /** Epoch ms the isolation began. */
  createdAt: number;
};

export type IsolationStatus = WorktreeIsolationStatus;

/** Normalize a root path so the in-memory map + persisted keys agree. */
function norm(root: string): string {
  return path.resolve(root);
}

/** Composite map key: a thread's isolation of a specific repo root. */
function compositeKey(threadId: string, root: string): string {
  return `${threadId}${KEY_SEP}${norm(root)}`;
}

/** A stable, filesystem-safe worktree directory name for a (thread, root) pair. */
function worktreeDirName(threadId: string, root: string): string {
  return createHash('sha1').update(`${threadId}${KEY_SEP}${norm(root)}`).digest('hex').slice(0, 16);
}

/* ── pure (de)serialization — headless-tested ─────────────────────────────── */

/** Parse the persisted isolation file into a compositeKey→state map (tolerant). */
export function parseIsolationState(raw: unknown): Map<string, IsolationState> {
  const out = new Map<string, IsolationState>();
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { entries?: unknown }).entries)
    ? (raw as { entries: unknown[] }).entries
    : [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    if (
      typeof r.root === 'string' &&
      typeof r.worktreePath === 'string' &&
      typeof r.branch === 'string' &&
      r.branch.length > 0
    ) {
      const threadId = typeof r.threadId === 'string' && r.threadId.length > 0 ? r.threadId : DEFAULT_THREAD;
      const root = norm(r.root);
      out.set(compositeKey(threadId, root), {
        threadId,
        root,
        worktreePath: r.worktreePath,
        branch: r.branch,
        createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
      });
    }
  }
  return out;
}

/** Serialize the map to the on-disk shape. */
export function serializeIsolationState(map: Map<string, IsolationState>): string {
  return JSON.stringify({ entries: [...map.values()] }, null, 2);
}

/* ── module state + configuration ─────────────────────────────────────────── */

let state = new Map<string, IsolationState>();
let stateFile: string | null = null;
let worktreesDir: string | null = null;
let getActiveThreadId: () => string | null = () => DEFAULT_THREAD;

/** The active thread id (an empty conversation falls back to the default thread). */
function activeThread(): string {
  const id = getActiveThreadId();
  return id && id.length > 0 ? id : DEFAULT_THREAD;
}

/**
 * Wire the persistence file, worktree parent dir, and active-thread accessor
 * (once, from main) and restore any in-progress isolation, dropping entries whose
 * worktree no longer exists on disk/in git.
 */
export async function configureWorktreeIsolation(opts: {
  stateFile: string;
  worktreesDir: string;
  getActiveThreadId?: () => string | null;
}): Promise<void> {
  stateFile = opts.stateFile;
  worktreesDir = opts.worktreesDir;
  if (opts.getActiveThreadId) getActiveThreadId = opts.getActiveThreadId;
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(opts.stateFile, 'utf8'));
  } catch {
    raw = null;
  }
  const restored = parseIsolationState(raw);
  for (const [key, st] of restored) {
    if (await isWorktreeLive(st.root, st.worktreePath)) state.set(key, st);
  }
  if (state.size !== restored.size) await persist();
}

async function persist(): Promise<void> {
  if (stateFile) await atomicWriteFile(stateFile, serializeIsolationState(state));
}

/** Whether the recorded worktree is still attached to the repo. */
async function isWorktreeLive(root: string, worktreePath: string): Promise<boolean> {
  try {
    const list = await listWorktrees(root);
    return list.some((w) => path.resolve(w.path) === path.resolve(worktreePath));
  } catch {
    return false;
  }
}

/* ── reads (sync — used on the hot agent path) ────────────────────────────── */

/** The active thread's isolation for a repo root, or null. */
export function getIsolation(root: string): IsolationState | null {
  return state.get(compositeKey(activeThread(), root)) ?? null;
}

/**
 * The root the AGENT should operate on for the ACTIVE thread: the isolation
 * worktree when active, else the workspace root unchanged. Sync + allocation-
 * light so the loop can call it per turn. Isolation OFF ⇒ returns `root`.
 */
export function effectiveAgentRoot(root: string): string {
  return state.get(compositeKey(activeThread(), root))?.worktreePath ?? root;
}

/* ── orchestration (async — touches git/disk) ─────────────────────────────── */

/** Whether a root can be isolated: a local git repo (engine rejects SSH/non-git). */
export async function canIsolate(root: string): Promise<boolean> {
  return isGitRepo(root);
}

/**
 * Begin (or reuse) an isolated worktree for the active thread + `root`.
 * Idempotent per thread. Refuses a non-git/SSH root.
 */
export async function enterIsolation(root: string): Promise<IsolationStatus> {
  const threadId = activeThread();
  const key = compositeKey(threadId, root);
  if (state.has(key)) return isolationStatus(root);
  if (!worktreesDir) throw new Error('worktree isolation is not configured');
  if (!(await isGitRepo(root))) {
    throw new Error('isolation needs a local git repository');
  }
  const branch = agentBranchName();
  const worktreePath = path.join(worktreesDir, worktreeDirName(threadId, root));
  await createWorktree(root, worktreePath, branch);
  state.set(key, { threadId, root: norm(root), worktreePath, branch, createdAt: Date.now() });
  await persist();
  return isolationStatus(root);
}

/**
 * Merge the active thread's isolation back into the base branch and end it on
 * success. A conflict leaves the worktree intact (isolation still active) so the
 * user can resolve it.
 */
export async function mergeIsolation(root: string): Promise<WorktreeMergeResult> {
  const key = compositeKey(activeThread(), root);
  const st = state.get(key);
  if (!st) return { ok: false, reason: 'error', message: 'no active isolation' };
  const result = await mergeWorktree(st.root, st.worktreePath, st.branch, 'Agent isolated changes');
  if (result.ok) {
    state.delete(key);
    await persist();
  }
  return result;
}

/** Discard the active thread's isolation: drop the worktree + branch. */
export async function discardIsolation(root: string): Promise<void> {
  const key = compositeKey(activeThread(), root);
  const st = state.get(key);
  if (!st) return;
  await discardWorktree(st.root, st.worktreePath, st.branch);
  state.delete(key);
  await persist();
}

/** The renderer-facing status for the active thread + root. */
export async function isolationStatus(root: string): Promise<IsolationStatus> {
  const st = state.get(compositeKey(activeThread(), root));
  if (!st) return { active: false, eligible: await canIsolate(root) };
  let changes: WorktreeChanges;
  try {
    changes = await worktreeChanges(st.worktreePath);
  } catch {
    changes = { count: 0, files: [] };
  }
  return { active: true, eligible: true, branch: st.branch, worktreePath: st.worktreePath, changes };
}

/** Test-only reset of module state. */
export function __resetWorktreeIsolationForTests(): void {
  state = new Map();
  stateFile = null;
  worktreesDir = null;
  getActiveThreadId = () => DEFAULT_THREAD;
}
