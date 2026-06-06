import fs from 'node:fs';
import path from 'node:path';
import type { Diagnostic, DiagnosticSeverity } from '../../shared/diagnostics';

/**
 * Checker recipes (docs/workspace-language-support-design.md, Tier 1). Each
 * recipe is { which marker makes it apply, what command to resolve for a root,
 * how to parse its output }. This is the externalizable spine: a new language is
 * a new entry, not new branching code. Built-ins ship here; user/plugin recipes
 * (Tier 1 L2) layer on via the same shape, referencing a PARSERS entry by name
 * since they can't ship arbitrary JS parsers.
 *
 * Parsers are pure (output, root) → Diagnostic[] functions — trivially testable.
 */

/** A named output parser. External recipes reference these by key. */
export type ParserId = 'tsc' | 'eslint-json';

export type CheckerRecipe = {
  /** Stable id; also the default Diagnostic.source for findings this produces. */
  id: string;
  /** Human label for UI. */
  label: string;
  /** Any one of these files present at the root makes this checker apply. */
  appliesWhen: readonly string[];
  /**
   * Resolve the shell command to run in `root` (or null to skip for this root).
   * Lets a recipe prefer the project's own npm script over a generic invocation.
   */
  resolveCommand: (root: string) => string | null;
  /** Parser key — resolved to a function via {@link PARSERS}. */
  parser: ParserId;
};

/* ── parsers ─────────────────────────────────────────────────────────────── */

/** Normalize a path to a workspace-relative POSIX path. */
function toRel(file: string, root: string): string {
  const abs = path.isAbsolute(file) ? path.relative(root, file) : file;
  return abs.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Parse `tsc` output (run with `--pretty false`), e.g.:
 *   src/main.tsx(2,10): error TS2307: Cannot find module 'react-dom/client'.
 * tsc writes diagnostics to stdout; non-matching lines (the "Found N errors"
 * trailer, message continuations) are skipped.
 */
export function parseTsc(output: string, root: string): Diagnostic[] {
  const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;
  const out: Diagnostic[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const m = re.exec(raw);
    if (!m) continue;
    const [, file, line, col, sev, code, message] = m;
    out.push({
      file: toRel(file, root),
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

type EslintMessage = {
  severity?: unknown;
  message?: unknown;
  line?: unknown;
  column?: unknown;
  endLine?: unknown;
  endColumn?: unknown;
  ruleId?: unknown;
};
type EslintFile = { filePath?: unknown; messages?: unknown };

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function optNum(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Parse ESLint's `--format json` output: an array of { filePath, messages[] }
 * where each message has severity (1=warn, 2=error), line/column, ruleId. Paths
 * are absolute, so they're relativized against the root. Non-JSON (a config crash
 * printed instead) yields no findings — the run's exit code still flags failure.
 */
export function parseEslintJson(output: string, root: string): Diagnostic[] {
  let data: unknown;
  try {
    data = JSON.parse(output);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: Diagnostic[] = [];
  for (const entry of data) {
    const file = entry as EslintFile;
    if (typeof file.filePath !== 'string' || !Array.isArray(file.messages)) continue;
    const rel = toRel(file.filePath, root);
    for (const raw of file.messages) {
      const m = raw as EslintMessage;
      const severity: DiagnosticSeverity = m.severity === 2 ? 'error' : 'warning';
      out.push({
        file: rel,
        line: num(m.line, 1),
        column: num(m.column, 1),
        endLine: optNum(m.endLine),
        endColumn: optNum(m.endColumn),
        severity,
        code: typeof m.ruleId === 'string' ? m.ruleId : undefined,
        message: typeof m.message === 'string' ? m.message : '',
        source: 'eslint',
      });
    }
  }
  return out;
}

/** Registry of named parsers — external recipes reference these by {@link ParserId}. */
export const PARSERS: Record<ParserId, (output: string, root: string) => Diagnostic[]> = {
  tsc: parseTsc,
  'eslint-json': parseEslintJson,
};

/* ── command resolution helpers ──────────────────────────────────────────── */

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Whether package.json at `root` defines a non-empty script `name`. */
export function hasNpmScript(root: string, name: string): boolean {
  const pkg = readJson(path.join(root, 'package.json'));
  const scripts = pkg && typeof pkg === 'object' ? (pkg as { scripts?: unknown }).scripts : null;
  if (!scripts || typeof scripts !== 'object') return false;
  const value = (scripts as Record<string, unknown>)[name];
  return typeof value === 'string' && value.trim().length > 0;
}

/* ── built-in recipes ────────────────────────────────────────────────────── */

export const CHECKERS: readonly CheckerRecipe[] = [
  {
    id: 'tsc',
    label: 'TypeScript',
    appliesWhen: ['tsconfig.json'],
    // Prefer the project's own `typecheck` script (its real flags) — fall back to
    // a generic `tsc -b` (honors project references + each tsconfig's noEmit).
    // `--pretty false` gives the single-line format parseTsc expects; `--silent`
    // trims npm's own wrapper noise. `--no-install` keeps npx from fetching tsc.
    resolveCommand: (root) =>
      hasNpmScript(root, 'typecheck')
        ? 'npm run typecheck --silent'
        : 'npx --no-install tsc -b --pretty false',
    parser: 'tsc',
  },
  {
    id: 'eslint',
    label: 'ESLint',
    appliesWhen: [
      '.eslintrc',
      '.eslintrc.js',
      '.eslintrc.cjs',
      '.eslintrc.json',
      '.eslintrc.yml',
      '.eslintrc.yaml',
      'eslint.config.js',
      'eslint.config.mjs',
      'eslint.config.cjs',
      'eslint.config.ts',
    ],
    // Run ESLint directly with JSON output (a project `lint` script rarely emits
    // JSON). `.` lints the project per its config/ignores.
    resolveCommand: () => 'npx --no-install eslint . --format json',
    parser: 'eslint-json',
  },
];
