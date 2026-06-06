import { getDiagnosticsState, runDiagnostics } from '../../diagnostics/runner';
import { scrubText } from '../../../shared/scrub';
import type { Diagnostic, DiagnosticsState } from '../../../shared/diagnostics';
import type { Executor, ToolResult } from './types';

/**
 * The agent's two diagnostics tools (docs/workspace-language-support-design.md,
 * Tier 1), both built on the project's OWN checker so findings carry the real
 * project config:
 *
 *   read_diagnostics — read-only view of the cached last pass (ungated).
 *   run_diagnostics  — run the checker now, return structured findings, AND
 *                      populate the shared cache (gated — it executes the
 *                      project's tooling). Because it calls the same
 *                      runDiagnostics() the IPC handler uses, the human's
 *                      Problems indicator + Monaco squiggles update live too.
 *
 * Fresh results come from run_diagnostics (or approval-gated run_command); the
 * read path stays ungated.
 */

/** Cap how many findings are rendered to the model so a noisy repo can't flood it. */
const MAX_SHOWN = 100;

const SEV_RANK: Record<Diagnostic['severity'], number> = { error: 0, warning: 1, info: 2 };

function pathFilter(input: Record<string, unknown>): string | null {
  return typeof input.path === 'string' ? input.path.replace(/\\/g, '/') : null;
}

function formatOne(d: Diagnostic): string {
  const code = d.code ? ` ${d.code}` : '';
  return `  ${d.line}:${d.column} ${d.severity}${code} — ${d.message} [${d.source}]`;
}

/** Render a diagnostics state (errors first, grouped by file) for the model. */
function formatState(summaryName: string, state: DiagnosticsState, filter: string | null): ToolResult {
  // Merge the batch checker pass with live language-server findings (Tier 2).
  const combined = [...(state.lastRun?.diagnostics ?? []), ...state.live];
  const checkerId = state.lastRun?.checkerId ?? (state.live.length > 0 ? 'lsp' : 'none');
  if (!state.lastRun && state.live.length === 0) {
    return {
      summary: summaryName,
      text: "No diagnostics cached yet. Use run_diagnostics to compute them (or run_command with the project's checker, e.g. `npm run typecheck`).",
    };
  }

  let diags = combined;
  if (filter) diags = diags.filter((d) => d.file === filter);

  const errors = diags.filter((d) => d.severity === 'error').length;
  const warnings = diags.filter((d) => d.severity === 'warning').length;

  if (diags.length === 0) {
    const scope = filter ? ` for ${filter}` : '';
    return {
      summary: `${summaryName}: clean`,
      text: `No diagnostics${scope} (checker: ${checkerId}). The last check was clean.`,
    };
  }

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
  const header = `${errors} error(s), ${warnings} warning(s) — checker: ${checkerId}`;

  return {
    summary: `${summaryName}: ${errors}E ${warnings}W`,
    text: scrubText(`${header}\n\n${lines.join('\n')}${more}`),
  };
}

export const readDiagnostics: Executor = (input, ctx): Promise<ToolResult> => {
  if (!ctx.ws) {
    return Promise.resolve({ summary: 'read_diagnostics', text: 'no workspace is open.', isError: true });
  }
  const state = getDiagnosticsState(ctx.ws.root);
  if (state.running) {
    return Promise.resolve({
      summary: 'read_diagnostics',
      text: 'a diagnostics check is currently running — try again shortly.',
    });
  }
  return Promise.resolve(formatState('read_diagnostics', state, pathFilter(input)));
};

export const runDiagnosticsTool: Executor = async (input, ctx): Promise<ToolResult> => {
  if (!ctx.ws) {
    return { summary: 'run_diagnostics', text: 'no workspace is open.', isError: true };
  }
  // Same path the renderer "Check" button uses: runs the applicable checkers,
  // caches the result, and pushes diagnostics:update — so squiggles + the
  // Problems indicator refresh from this very call.
  const state = await runDiagnostics(ctx.ws.root);
  return formatState('run_diagnostics', state, pathFilter(input));
};
