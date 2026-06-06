import { useEffect, useRef } from 'react';
import { useEditorStore } from '../editor/store';
import { useDiagnosticsStore, currentDiagnostics } from './store';
import type { Diagnostic } from '../../../shared/diagnostics';
import { cn } from '../../lib/cn';

/**
 * Problems list (docs/workspace-language-support-design.md, Tier 1 #4). Opens
 * above the StatusBar indicator and lists the cached checker findings grouped by
 * file; a row click jumps to that file:line in the editor (the same openFileAt the
 * search panel uses). Also re-runs the checker and opens the user's languages.json.
 *
 * Kept as a status-bar popover (not a left-rail view) so it adds no ActivityBar /
 * i18n surface — the squiggles already cover in-editor display.
 */

const SEV_RANK: Record<Diagnostic['severity'], number> = { error: 0, warning: 1, info: 2 };

function severityGlyph(severity: Diagnostic['severity']): { glyph: string; cls: string } {
  if (severity === 'error') return { glyph: '✖', cls: 'text-error' };
  if (severity === 'warning') return { glyph: '⚠', cls: 'text-warning' };
  return { glyph: 'ℹ', cls: 'text-fg-tertiary' };
}

function groupByFile(diags: readonly Diagnostic[]): [string, Diagnostic[]][] {
  const byFile = new Map<string, Diagnostic[]>();
  for (const d of [...diags].sort(
    (a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.line - b.line,
  )) {
    const list = byFile.get(d.file) ?? [];
    list.push(d);
    byFile.set(d.file, list);
  }
  return [...byFile.entries()];
}

export function ProblemsPopover({ onClose }: { onClose: () => void }) {
  const state = useDiagnosticsStore((s) => s.state);
  const run = useDiagnosticsStore((s) => s.run);
  const openFileAt = useEditorStore((s) => s.openFileAt);
  const ref = useRef<HTMLDivElement | null>(null);

  // Dismiss on outside click / Escape.
  useEffect(() => {
    // Use 'click' (not 'mousedown') so toggling via the StatusBar button — whose
    // onClick fires first and closes the popover — doesn't get reopened by a
    // close-then-reopen race.
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const diags = currentDiagnostics(state);
  const groups = groupByFile(diags);

  const openConfig = (): void => {
    void window.marudesk.invoke('diagnostics:open-config').catch(() => undefined);
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Problems"
      className="chrome-popover absolute bottom-[calc(100%+4px)] right-0 z-50 w-[420px] max-h-[60vh] flex flex-col rounded text-caption animate-scale-in"
    >
      <header className="flex items-center gap-2 px-3 py-2 border-b border-subtle">
        <span className="font-medium text-fg-secondary">Problems</span>
        <span className="text-fg-tertiary">
          {state.lastRun
            ? `${diags.filter((d) => d.severity === 'error').length} errors, ${diags.filter((d) => d.severity === 'warning').length} warnings`
            : 'not checked yet'}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void run()}
          disabled={state.running}
          className="px-2 py-0.5 rounded hover:bg-surface-3 disabled:opacity-60"
          title="Run the project checker"
        >
          {state.running ? 'checking…' : 'Run check'}
        </button>
        <button
          type="button"
          onClick={openConfig}
          className="px-2 py-0.5 rounded hover:bg-surface-3"
          title="Edit languages.json (external checker recipes)"
        >
          Configure
        </button>
      </header>

      <div className="flex-1 overflow-auto py-1">
        {groups.length === 0 ? (
          <p className="px-3 py-4 text-fg-tertiary">
            {state.lastRun
              ? `No problems — the last check was clean (${state.lastRun.checkerId}).`
              : 'Run a check to see compiler/linter problems here.'}
          </p>
        ) : (
          groups.map(([file, list]) => (
            <div key={file} className="px-1 py-0.5">
              <div className="px-2 py-1 text-fg-tertiary truncate" title={file}>
                {file}
              </div>
              <ul>
                {list.map((d, i) => {
                  const { glyph, cls } = severityGlyph(d.severity);
                  return (
                    <li key={`${d.line}:${d.column}:${i}`}>
                      <button
                        type="button"
                        onClick={() => {
                          void openFileAt(d.file, d.line, d.column);
                          onClose();
                        }}
                        className="w-full flex items-start gap-2 px-3 py-1 text-left rounded hover:bg-surface-3"
                      >
                        <span className={cn('shrink-0 mt-px', cls)} aria-hidden>
                          {glyph}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="text-fg-secondary break-words">{d.message}</span>
                          <span className="text-fg-tertiary">
                            {' '}
                            {d.code ? `${d.code} · ` : ''}
                            {d.line}:{d.column} · {d.source}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
