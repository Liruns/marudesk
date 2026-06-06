import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { inheritSafeEnv } from '../proc-env';
import type { Diagnostic, DiagnosticsRun, DiagnosticsState } from '../../shared/diagnostics';
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

/** Wire the renderer-push listener once (from main.ts via handlers.ts). */
export function setDiagnosticsListener(fn: ((state: DiagnosticsState) => void) | null): void {
  listener = fn;
}

function stateFor(root: string | null): DiagnosticsState {
  const run = root !== null && lastRunRoot === root ? lastRun : null;
  const live = root !== null ? (liveByRoot.get(root) ?? []) : [];
  return { root, running: runningRoot !== null && runningRoot === root, lastRun: run, live };
}

/** Replace the live (LSP) diagnostics for a root and push the merged state. */
export function setLiveDiagnostics(root: string, diagnostics: Diagnostic[]): void {
  if (diagnostics.length === 0) liveByRoot.delete(root);
  else liveByRoot.set(root, diagnostics);
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
function runOne(command: string, cwd: string): Promise<CheckerOutput> {
  return new Promise((resolve) => {
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
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout: '', stderr: `failed to start: ${err.message}`, exitCode: null, truncated });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
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
 */
export async function runDiagnostics(root: string): Promise<DiagnosticsState> {
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
    for (const checker of checkers) {
      const command = checker.resolveCommand(root);
      if (!command) continue; // recipe opted out for this root
      commands.push(command);
      ran.push(checker.id);
      // A checker that has run participates in the aggregate exit code (start at 0).
      if (exitCode === null) exitCode = 0;
      const result = await runOne(command, root);
      if (result.truncated) truncated = true;
      diagnostics.push(...checker.parse(result.stdout, root));
      // Surface the first non-zero/failed exit (a clean pass leaves it at 0).
      if (result.exitCode !== 0) exitCode = result.exitCode;
    }
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
