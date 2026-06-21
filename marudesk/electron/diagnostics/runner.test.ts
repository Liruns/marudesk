import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CheckerRecipe } from './checkers';

/**
 * The runner pulls its applicable recipes from ./config (which imports electron's
 * `app`). Mock it so these tests stay headless and we fully control the checker
 * set, their commands, and exit codes.
 */
const activeCheckers: CheckerRecipe[] = [];
vi.mock('./config', () => ({
  getActiveCheckers: (): CheckerRecipe[] => activeCheckers,
}));

import { runDiagnostics } from './runner';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-runner-'));
  // Every checker below applies via this marker.
  fs.writeFileSync(path.join(root, 'marker'), '');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  activeCheckers.length = 0;
});

/** A checker that runs `node -e "process.exit(code)"`, with an optional parse hook. */
function makeChecker(id: string, code: number, onParse?: () => void): CheckerRecipe {
  return {
    id,
    label: id,
    appliesWhen: ['marker'],
    resolveCommand: () => `node -e "process.exit(${code})"`,
    parse: () => {
      onParse?.();
      return [];
    },
  };
}

describe('runDiagnostics aggregate exitCode honesty', () => {
  it('reports 0 when all applicable checkers run clean', async () => {
    activeCheckers.push(makeChecker('a', 0), makeChecker('b', 0));
    const state = await runDiagnostics(root);
    expect(state.lastRun?.exitCode).toBe(0);
    expect(state.lastRun?.checkerId).toBe('a+b');
  });

  it('surfaces a real non-zero exit from a checker that ran', async () => {
    activeCheckers.push(makeChecker('a', 0), makeChecker('b', 2));
    const state = await runDiagnostics(root);
    expect(state.lastRun?.exitCode).toBe(2);
  });

  it('downgrades a stale clean exit to null when an abort truncates the applicable set', async () => {
    const ac = new AbortController();
    // First checker passes (exit 0); abort fires in the gap before the second is
    // ever spawned (during the first leg's parse). The aggregate must NOT claim a
    // clean pass — a checker never ran.
    activeCheckers.push(
      makeChecker('first', 0, () => ac.abort()),
      makeChecker('second', 0),
    );
    const state = await runDiagnostics(root, ac.signal);
    expect(state.lastRun?.exitCode).toBeNull();
    // Only the first checker actually ran.
    expect(state.lastRun?.checkerId).toBe('first');
  });

  it('keeps a real failure even when a later abort truncates the set', async () => {
    const ac = new AbortController();
    activeCheckers.push(
      makeChecker('first', 3, () => ac.abort()),
      makeChecker('second', 0),
    );
    const state = await runDiagnostics(root, ac.signal);
    // The failure a checker that DID run recorded is not masked by the abort.
    expect(state.lastRun?.exitCode).toBe(3);
  });

  it('reports 0 for a complete clean run that was never aborted (signal present)', async () => {
    const ac = new AbortController();
    activeCheckers.push(makeChecker('a', 0), makeChecker('b', 0));
    const state = await runDiagnostics(root, ac.signal);
    expect(state.lastRun?.exitCode).toBe(0);
    expect(state.lastRun?.checkerId).toBe('a+b');
  });
});
