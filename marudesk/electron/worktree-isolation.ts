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
 * Worktree isolation lifecycle (Stage 12-B-1) — wires the 12-A engine into the
 * agent. A workspace can opt into running the agent in a dedicated git worktree:
 * the agent's effective root is swapped to the worktree, so its file edits,
 * run_command, and diagnostics all happen on an isolated branch, then merge back
 * into the base branch or discard as a unit. Editor/UI keep the main root — the
 * isolated edits are reviewed via the chat's own diff/changes, then merged.
 *
 * State is keyed by the main repo root and persisted (so an in-progress isolated
 * run survives a restart). The decision logic + (de)serialization are pure and
 * headless-tested; only `configure` + the orchestrator touch git/disk.
 */

/** One workspace's active isolation, persisted under userData. */
export type IsolationState = {
  /** The main repo root this worktree isolates (normalized absolute path). */
  root: string;
  /** Absolute path of the agent's worktree working directory. */
  worktreePath: string;
  /** The `marudesk/agent/*` branch checked out in the worktree. */
  branch: string;
  /** Epoch ms the isolation began. */
  createdAt: number;
};

/** Status surfaced to the renderer for one workspace root (shared shape). */
export type IsolationStatus = WorktreeIsolationStatus;

/** Normalize a root path so the in-memory map + persisted keys agree. */
function norm(root: string): string {
  return path.resolve(root);
}

/** A stable, filesystem-safe worktree directory name for a repo root. */
function worktreeDirName(root: string): string {
  return createHash('sha1').update(norm(root)).digest('hex').slice(0, 12);
}

/* ── pure (de)serialization — headless-tested ─────────────────────────────── */

/** Parse the persisted isolation file into a root→state map (tolerant of junk). */
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
      const root = norm(r.root);
      out.set(root, {
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

/**
 * Wire the persistence file + worktree parent dir (once, from main) and restore
 * any in-progress isolation, dropping entries whose worktree no longer exists on
 * disk/in git (a manual cleanup or a crash between remove and persist).
 */
export async function configureWorktreeIsolation(opts: {
  stateFile: string;
  worktreesDir: string;
}): Promise<void> {
  stateFile = opts.stateFile;
  worktreesDir = opts.worktreesDir;
  let raw: unknown = null;
  try {
    raw = JSON.parse(await fs.readFile(opts.stateFile, 'utf8'));
  } catch {
    raw = null;
  }
  const restored = parseIsolationState(raw);
  // Drop stale entries (worktree gone) so the effective root never points at a
  // vanished dir.
  for (const [root, st] of restored) {
    const live = await isWorktreeLive(root, st.worktreePath);
    if (live) state.set(root, st);
  }
  if (state.size !== restored.size) await persist();
}

async function persist(): Promise<void> {
  if (!stateFile) return;
  await atomicWriteFile(stateFile, serializeIsolationState(state));
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

/** The active isolation for a repo root, or null. */
export function getIsolation(root: string): IsolationState | null {
  return state.get(norm(root)) ?? null;
}

/**
 * The root the AGENT should operate on: the isolation worktree when active, else
 * the workspace root unchanged. Sync + allocation-free so the loop can call it
 * per turn. Isolation OFF ⇒ returns `root` (zero behavior change).
 */
export function effectiveAgentRoot(root: string): string {
  return state.get(norm(root))?.worktreePath ?? root;
}

/* ── orchestration (async — touches git/disk) ─────────────────────────────── */

/** Whether a root can be isolated: a local git repo (engine rejects SSH/non-git). */
export async function canIsolate(root: string): Promise<boolean> {
  return isGitRepo(root);
}

/**
 * Begin (or reuse) an isolated worktree for `root`. Idempotent: if isolation is
 * already active, returns the current status. Refuses a non-git/SSH root.
 */
export async function enterIsolation(root: string): Promise<IsolationStatus> {
  const key = norm(root);
  const existing = state.get(key);
  if (existing) return isolationStatus(root);
  if (!worktreesDir) throw new Error('worktree isolation is not configured');
  if (!(await isGitRepo(root))) {
    throw new Error('isolation needs a local git repository');
  }
  const branch = agentBranchName();
  const worktreePath = path.join(worktreesDir, worktreeDirName(root));
  await createWorktree(root, worktreePath, branch);
  state.set(key, { root: key, worktreePath, branch, createdAt: Date.now() });
  await persist();
  return isolationStatus(root);
}

/**
 * Merge the active isolation back into the base branch and end isolation on
 * success. A conflict leaves the worktree intact (and isolation active) so the
 * user can resolve it; the result carries the reason.
 */
export async function mergeIsolation(root: string): Promise<WorktreeMergeResult> {
  const key = norm(root);
  const st = state.get(key);
  if (!st) return { ok: false, reason: 'error', message: 'no active isolation' };
  const result = await mergeWorktree(st.root, st.worktreePath, st.branch, 'Agent isolated changes');
  if (result.ok) {
    state.delete(key);
    await persist();
  }
  return result;
}

/** Discard the active isolation: drop the worktree + branch, end isolation. */
export async function discardIsolation(root: string): Promise<void> {
  const key = norm(root);
  const st = state.get(key);
  if (!st) return;
  await discardWorktree(st.root, st.worktreePath, st.branch);
  state.delete(key);
  await persist();
}

/** The renderer-facing status for a root (active branch + pending change count). */
export async function isolationStatus(root: string): Promise<IsolationStatus> {
  const st = state.get(norm(root));
  if (!st) return { active: false, eligible: await canIsolate(root) };
  let changes: WorktreeChanges;
  try {
    changes = await worktreeChanges(st.worktreePath);
  } catch {
    changes = { count: 0, files: [] };
  }
  return { active: true, eligible: true, branch: st.branch, worktreePath: st.worktreePath, changes };
}

/** Test-only reset of module state (so harness runs are isolated). */
export function __resetWorktreeIsolationForTests(): void {
  state = new Map();
  stateFile = null;
  worktreesDir = null;
}
