import type { Diagnostic } from '../../shared/diagnostics';

/**
 * Checker recipes (docs/workspace-language-support-design.md, Tier 1). Each
 * recipe is { which marker makes it apply, what command to run, how to parse its
 * output into structured diagnostics }. This is the externalizable spine: new
 * language support is a new entry, not new branching code. Tier 1 ships a
 * curated default (TypeScript); user/plugin-contributed recipes layer on later.
 *
 * Parsers are pure string→Diagnostic[] functions, so they're trivially testable
 * and free of any runtime dependency.
 */

export type CheckerRecipe = {
  /** Stable id, also the Diagnostic.source for findings this produces. */
  id: string;
  /** Human label for UI. */
  label: string;
  /** Shell command, run in the workspace root. Must terminate on its own. */
  command: string;
  /** Any one of these files present at the root makes this checker apply. */
  appliesWhen: readonly string[];
  /** Parse combined stdout+stderr into diagnostics (paths workspace-relative). */
  parse: (output: string) => Diagnostic[];
};

/** Normalize a checker-emitted path to a workspace-relative POSIX path. */
function toPosix(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Parse `tsc` output (run with `--pretty false` so locations are single-line and
 * uncolored), e.g.:
 *   src/main.tsx(2,10): error TS2307: Cannot find module 'react-dom/client'.
 * Non-matching lines (the "Found N errors" trailer, message continuations) are
 * skipped — a missed continuation is acceptable for Tier 1.
 */
export function parseTsc(output: string): Diagnostic[] {
  const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;
  const out: Diagnostic[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const m = re.exec(raw);
    if (!m) continue;
    const [, file, line, col, sev, code, message] = m;
    out.push({
      file: toPosix(file),
      line: Number(line),
      column: Number(col),
      severity: sev === 'warning' ? 'warning' : 'error',
      code,
      message: message.trim(),
      source: 'tsc',
    });
  }
  return out;
}

export const CHECKERS: readonly CheckerRecipe[] = [
  {
    id: 'tsc',
    label: 'TypeScript',
    // `-b` honors project references and each tsconfig's noEmit; `--pretty false`
    // gives the single-line, uncolored format parseTsc expects. `--no-install`
    // keeps npx from trying to fetch tsc when it isn't a project dependency
    // (the run then fails cleanly and surfaces as a checker error).
    command: 'npx --no-install tsc -b --pretty false',
    appliesWhen: ['tsconfig.json'],
    parse: parseTsc,
  },
];
