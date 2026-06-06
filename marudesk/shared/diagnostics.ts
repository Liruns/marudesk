/**
 * Diagnostics contract (docs/workspace-language-support-design.md, Tier 1). A
 * "diagnostic" is one finding produced by the OPEN PROJECT's own checker (tsc,
 * eslint, cargo, …) — marudesk runs the project's real tooling and parses its
 * output rather than embedding a language server per ecosystem, so the findings
 * carry the project's true config. The same parsed results feed both the agent
 * (read_diagnostics tool) and the human (Monaco squiggles + Problems panel).
 *
 * Pure data shared across main, renderer, and tests — no runtime imports.
 */

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export type Diagnostic = {
  /** Workspace-relative POSIX path the finding is on. */
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  /** Optional 1-based end position when the checker reports a range. */
  endLine?: number;
  endColumn?: number;
  severity: DiagnosticSeverity;
  message: string;
  /** Checker code, e.g. "TS2307" — undefined when the checker emits none. */
  code?: string;
  /** Checker id that produced this, e.g. "tsc". */
  source: string;
};

/** The outcome of one diagnostics pass over the workspace. */
export type DiagnosticsRun = {
  /** The checker(s) that ran, e.g. "tsc" (or "none" when none applied). */
  checkerId: string;
  /** The command line(s) executed, for display/debugging. */
  command: string;
  /** Process exit code of the (last failing) checker, or null if it never ran. */
  exitCode: number | null;
  /** Wall-clock duration of the pass in ms. */
  durationMs: number;
  diagnostics: Diagnostic[];
  /** Whether captured checker output was clipped before parsing. */
  truncated: boolean;
};

/**
 * The diagnostics state for a workspace root, pushed on `diagnostics:update` and
 * returned by `diagnostics:get`. `lastRun` is null until a check has run for the
 * given root.
 */
export type DiagnosticsState = {
  root: string | null;
  running: boolean;
  lastRun: DiagnosticsRun | null;
};
