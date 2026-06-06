import { getDiagnosticsState } from '../../diagnostics/runner';
import { scrubText } from '../../../shared/scrub';
import type { Diagnostic } from '../../../shared/diagnostics';
import type { Executor, ToolResult } from './types';

/**
 * `read_diagnostics` — read the latest cached compiler/linter findings for the
 * open workspace (docs/workspace-language-support-design.md, Tier 1). Read-only:
 * it returns what the project's checker last produced (the same results the
 * Problems panel shows), so the agent sees the project's TRUE config view without
 * re-running anything. To compute fresh results the agent uses run_command (which
 * is approval-gated); this tool just reads the shared cache.
 */

/** Cap how many findings are rendered to the model so a noisy repo can't flood it. */
const MAX_SHOWN = 100;

const SEV_RANK: Record<Diagnostic['severity'], number> = { error: 0, warning: 1, info: 2 };

function formatOne(d: Diagnostic): string {
  const code = d.code ? ` ${d.code}` : '';
  return `  ${d.line}:${d.column} ${d.severity}${code} — ${d.message} [${d.source}]`;
}

export const readDiagnostics: Executor = (input, ctx): Promise<ToolResult> => {
  if (!ctx.ws) {
    return Promise.resolve({
      summary: 'read_diagnostics',
      text: 'no workspace is open.',
      isError: true,
    });
  }
  const state = getDiagnosticsState(ctx.ws.root);
  if (state.running) {
    return Promise.resolve({
      summary: 'read_diagnostics',
      text: 'a diagnostics check is currently running — try again shortly.',
    });
  }
  if (!state.lastRun) {
    return Promise.resolve({
      summary: 'read_diagnostics',
      text: "No diagnostics cached yet. Run the project's checker with run_command (e.g. `npm run typecheck` or `tsc --noEmit`); results then appear here and in the Problems panel.",
    });
  }

  const filter = typeof input.path === 'string' ? input.path.replace(/\\/g, '/') : null;
  let diags = state.lastRun.diagnostics;
  if (filter) diags = diags.filter((d) => d.file === filter);

  const errors = diags.filter((d) => d.severity === 'error').length;
  const warnings = diags.filter((d) => d.severity === 'warning').length;

  if (diags.length === 0) {
    const scope = filter ? ` for ${filter}` : '';
    return Promise.resolve({
      summary: 'read_diagnostics: clean',
      text: `No diagnostics${scope} (checker: ${state.lastRun.checkerId}). The last check was clean.`,
    });
  }

  // Group by file, errors first, then by line.
  const byFile = new Map<string, Diagnostic[]>();
  for (const d of [...diags].sort(
    (a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.line - b.line,
  )) {
    const list = byFile.get(d.file) ?? [];
    list.push(d);
    byFile.set(d.file, list);
  }

  const lines: string[] = [];
  let shown = 0;
  for (const [file, list] of byFile) {
    if (shown >= MAX_SHOWN) break;
    lines.push(file);
    for (const d of list) {
      if (shown >= MAX_SHOWN) break;
      lines.push(formatOne(d));
      shown += 1;
    }
  }
  const more = diags.length > shown ? `\n…(${diags.length - shown} more not shown)` : '';
  const header = `${errors} error(s), ${warnings} warning(s) — checker: ${state.lastRun.checkerId}`;

  return Promise.resolve({
    summary: `read_diagnostics: ${errors}E ${warnings}W`,
    text: scrubText(`${header}\n\n${lines.join('\n')}${more}`),
  });
};
