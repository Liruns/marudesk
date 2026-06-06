import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { inheritSafeEnv } from '../proc-env';
import type { Diagnostic, DiagnosticsRun, DiagnosticsState } from '../../shared/diagnostics';
import { CHECKERS } from './checkers';

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

/** Wire the renderer-push listener once (from main.ts via handlers.ts). */
export function setDiagnosticsListener(fn: ((state: DiagnosticsState) => void) | null): void {
  listener = fn;
}

function stateFor(root: string | null): DiagnosticsState {
  const run = root !== null && lastRunRoot === root ? lastRun : null;
  return { root, running: runningRoot !== null && runningRoot === root, lastRun: run };
}

/** The current diagnostics state for a root (null lastRun until a pass runs for it). */
export function getDiagnosticsState(root: string | null): DiagnosticsState {
  return stateFor(root);
}

function emit(root: string): void {
  listener?.(stateFor(root));
}

/** Run one checker command, capturing combined stdout+stderr (bounded + timed). */
function runOne(command: string, cwd: string): Promise<{ output: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, env: inheritSafeEnv(), shell: true });
    let output = '';
    let truncated = false;
    const append = (chunk: Buffer): void => {
      if (truncated) return;
      output += chunk.toString('utf8');
      if (output.length > MAX_OUTPUT) {
        output = output.slice(0, MAX_OUTPUT);
        truncated = true;
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ output: `failed to start: ${err.message}`, exitCode: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ output, exitCode: code });
    });
  });
}

/** Recipes whose marker file exists at the workspace root. */
function applicableCheckers(root: string): typeof CHECKERS {
  return CHECKERS.filter((c) =>
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
    let exitCode: number | null = checkers.length > 0 ? 0 : null;
    let truncated = false;
    for (const checker of checkers) {
      commands.push(checker.command);
      const { output, exitCode: code } = await runOne(checker.command, root);
      if (output.length >= MAX_OUTPUT) truncated = true;
      diagnostics.push(...checker.parse(output));
      // Surface the first non-zero/failed exit (a clean pass leaves it at 0).
      if (code !== 0) exitCode = code;
    }
    lastRun = {
      checkerId: checkers.map((c) => c.id).join('+') || 'none',
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
