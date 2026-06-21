import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { inheritSafeEnv } from '../proc-env';
import type {
  Diagnostic,
  DiagnosticsRun,
  DiagnosticsState,
  LspServerStatus,
} from '../../shared/diagnostics';
import type { CheckerRecipe } from './checkers';
import { getActiveCheckers } from './config';

/**
 * Diagnostics runner (docs/workspace-language-support-design.md, Tier 1). Runs
 * the applicable checker recipes for a workspace root, parses their output into
 * structured diagnostics, and caches the last pass. One cache slot keyed by the
 * root it was computed for — switching workspaces makes the stale result read as
 * empty (the agent's read_diagnostics and the renderer both guard on root).
 *
 * The cache is observable: handlers.ts subscribes via {@link setDiagnosticsListener}
 * to push `diagnostics:update` to the renderer as a pass starts and finishes.
 */

/** Cap captured output before parsing so a pathological run can't be unbounded. */
const MAX_OUTPUT = 200_000;
/** Diagnostics passes are finite checks; bound them so a hung checker can't wedge. */
const TIMEOUT_MS = 180_000;

let lastRun: DiagnosticsRun | null = null;
let lastRunRoot: string | null = null;
let runningRoot: string | null = null;
let listener: ((state: DiagnosticsState) => void) | null = null;
/** Live language-server diagnostics per root (Tier 2), set by the LSP manager. */
const liveByRoot = new Map<string, Diagnostic[]>();
/** Language-server lifecycle rows per root (Tier 2), set by the LSP manager. */
const lspStatusByRoot = new Map<string, LspServerStatus[]>();

/** Wire the renderer-push listener once (from main.ts via handlers.ts). */
export function setDiagnosticsListener(fn: ((state: DiagnosticsState) => void) | null): void {
  listener = fn;
}

function stateFor(root: string | null): DiagnosticsState {
  const run = root !== null && lastRunRoot === root ? lastRun : null;
  const live = root !== null ? (liveByRoot.get(root) ?? []) : [];
  const lspServers = root !== null ? (lspStatusByRoot.get(root) ?? []) : [];
  return {
    root,
    running: runningRoot !== null && runningRoot === root,
    lastRun: run,
    live,
    lspServers,
  };
}

/** Replace the live (LSP) diagnostics for a root and push the merged state. */
export function setLiveDiagnostics(root: string, diagnostics: Diagnostic[]): void {
  if (diagnostics.length === 0) liveByRoot.delete(root);
  else liveByRoot.set(root, diagnostics);
  emit(root);
}

/** Replace the language-server lifecycle rows for a root and push state. */
export function setLspStatuses(root: string, statuses: LspServerStatus[]): void {
  if (statuses.length === 0) lspStatusByRoot.delete(root);
  else lspStatusByRoot.set(root, statuses);
  emit(root);
}

/** The current diagnostics state for a root (null lastRun until a pass runs for it). */
export function getDiagnosticsState(root: string | null): DiagnosticsState {
  return stateFor(root);
}

function emit(root: string): void {
  listener?.(stateFor(root));
}

type CheckerOutput = { stdout: string; stderr: string; exitCode: number | null; truncated: boolean };

/**
 * Run one checker command, capturing stdout and stderr SEPARATELY (bounded +
 * timed). Parsers receive stdout — checkers emit their machine-readable output
 * there (tsc diagnostics, eslint --format json), and keeping stderr out of it
 * stops a config-warning line from corrupting JSON parsing.
 */
function runOne(command: string, cwd: string, signal?: AbortSignal): Promise<CheckerOutput> {
  return new Promise((resolve) => {
    // An already-aborted signal must not even spawn the checker.
    if (signal?.aborted) {
      resolve({ stdout: '', stderr: 'aborted', exitCode: null, truncated: false });
      return;
    }
    const child = spawn(command, { cwd, env: inheritSafeEnv(), shell: true });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const onOut = (chunk: Buffer): void => {
      if (stdout.length >= MAX_OUTPUT) {
        truncated = true;
        return;
      }
      stdout += chunk.toString('utf8');
      if (stdout.length > MAX_OUTPUT) {
        stdout = stdout.slice(0, MAX_OUTPUT);
        truncated = true;
      }
    };
    const onErr = (chunk: Buffer): void => {
      if (stderr.length >= MAX_OUTPUT) return;
      stderr += chunk.toString('utf8');
      if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(0, MAX_OUTPUT);
    };
    child.stdout?.on('data', onOut);
    child.stderr?.on('data', onErr);
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    // Abort the checker early when the caller's run deadline fires, so a worktree
    // pre-flight probe is bound to the run budget and never self-bounds at the
    // full TIMEOUT_MS past it. `close` still resolves the promise afterward.
    const onAbort = (): void => {
      child.kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (err) => {
      finish();
      resolve({ stdout: '', stderr: `failed to start: ${err.message}`, exitCode: null, truncated });
    });
    child.on('close', (code) => {
      finish();
      resolve({ stdout, stderr, exitCode: code, truncated });
    });
  });
}

/** Active recipes (built-in + user languages.json) whose marker exists at root. */
function applicableCheckers(root: string): CheckerRecipe[] {
  return getActiveCheckers().filter((c) =>
    c.appliesWhen.some((marker) => {
      try {
        return fs.existsSync(path.join(root, marker));
      } catch {
        return false;
      }
    }),
  );
}

/**
 * Run all applicable checkers for `root`, parse + merge their diagnostics, cache
 * the result, and notify the listener (start + finish). Never throws — a checker
 * that fails to start is reflected in the run's exitCode, not an exception.
 *
 * An optional `signal` binds the checker legs to a caller deadline (e.g. a Work-OS
 * run budget): an aborted signal stops before the next checker and kills the
 * in-flight child. Additive — callers without a deadline pass nothing and the
 * pass self-bounds at {@link TIMEOUT_MS} per checker as before.
 */
export async function runDiagnostics(root: string, signal?: AbortSignal): Promise<DiagnosticsState> {
  const checkers = applicableCheckers(root);
  runningRoot = root;
  emit(root);
  const started = Date.now();
  try {
    const diagnostics: Diagnostic[] = [];
    const commands: string[] = [];
    const ran: string[] = [];
    let exitCode: number | null = null;
    let truncated = false;
    let abortedEarly = false;
    for (const checker of checkers) {
      if (signal?.aborted) {
        // Run deadline fired — stop before the next applicable checker. Some
        // applicable checker never ran, so the aggregate can't honestly claim a
        // clean pass (see the null downgrade below).
        abortedEarly = true;
        break;
      }
      const command = checker.resolveCommand(root);
      if (!command) continue; // recipe opted out for this root
      commands.push(command);
      ran.push(checker.id);
      // A checker that has run participates in the aggregate exit code (start at 0).
      if (exitCode === null) exitCode = 0;
      const result = await runOne(command, root, signal);
      if (result.truncated) truncated = true;
      diagnostics.push(...checker.parse(result.stdout, root));
      // Surface the first non-zero/failed exit (a clean pass leaves it at 0).
      if (result.exitCode !== 0) exitCode = result.exitCode;
    }
    // An abort that truncated the applicable set leaves earlier checkers' clean
    // exit (0) as the aggregate, which probeChangedFiles would read as verified
    // even though a checker never ran. Downgrade a stale clean exit to the
    // "no checker conclusively ran" sentinel (null → verified:undefined). A real
    // failure (non-zero) already recorded by a checker that DID run is kept.
    if (abortedEarly && exitCode === 0) exitCode = null;
    lastRun = {
      checkerId: ran.join('+') || 'none',
      command: commands.join(' && '),
      exitCode,
      durationMs: Date.now() - started,
      diagnostics,
      truncated,
    };
    lastRunRoot = root;
  } finally {
    runningRoot = null;
    emit(root);
  }
  return stateFor(root);
}
