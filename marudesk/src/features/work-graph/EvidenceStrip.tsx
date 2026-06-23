import { cn } from '../../lib/cn';
import type { Criterion } from '../../../shared/work-os';
import { useWorkGraphStore } from './store';

const VERDICT_DOT: Record<Criterion['verdict'], string> = {
  unknown: 'bg-fg-tertiary',
  pass: 'bg-success',
  fail: 'bg-error',
};

/**
 * Mission Control's bottom Evidence strip — the verdict summary for the selected
 * Task: its acceptance verdicts (system-filled, never agent-claimed) plus the
 * latest run note. Replaces the legacy StatusBar on this surface.
 *
 * Honesty note: a "pass" here is stamped by the APPLY-TIME static checker
 * (typecheck · lint · build over the changed files) — see
 * `criterionVerifiableByChecker` and store.applyPatch. It is NOT live CDP
 * "runtime evidence" (that term belongs to the DevTools timeline), and
 * behavioral criteria the checker can't prove stay `unknown`. So the count is
 * worded "verified" (with a tooltip naming the checker), never "verified by
 * runtime", which over-claimed.
 */
export function EvidenceStrip() {
  const graph = useWorkGraphStore((s) => s.graph);
  const selectedTaskId = useWorkGraphStore((s) => s.selectedTaskId);
  const runNote = useWorkGraphStore((s) => s.runNote);
  const task = graph?.tasks.find((t) => t.id === selectedTaskId);
  const passed = task ? task.acceptance.filter((c) => c.verdict === 'pass').length : 0;
  const total = task ? task.acceptance.length : 0;
  const MAX_DOTS = 12;
  const visibleDots = task ? task.acceptance.slice(0, MAX_DOTS) : [];
  const overflowDots = total - visibleDots.length;

  return (
    <footer
      role="contentinfo"
      className="h-6 shrink-0 flex items-center gap-3 px-3 text-caption tabular-nums bg-surface-1 border-t border-subtle text-fg-tertiary select-none"
    >
      <span className="shrink-0 text-fg-secondary">Evidence</span>
      {task ? (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate max-w-[220px]">{task.title}</span>
          {task.acceptance.length > 0 ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="flex min-w-0 shrink items-center gap-0.5 overflow-hidden">
                {visibleDots.map((c) => (
                  <span key={c.id} aria-hidden className={cn('size-1.5 shrink-0 rounded-pill', VERDICT_DOT[c.verdict])} />
                ))}
                {overflowDots > 0 ? (
                  <span aria-hidden className="shrink-0 text-caption text-fg-quaternary">
                    +{overflowDots}
                  </span>
                ) : null}
              </span>
              <span
                className="min-w-0 shrink truncate tabular-nums"
                title="Verdicts are system-filled by the apply-time checker (typecheck · lint · build over the changed files). Behavioral criteria the checker can't prove stay unverified."
              >
                {passed}/{total} verified
              </span>
            </span>
          ) : (
            <span className="shrink-0 text-fg-quaternary">no acceptance criteria</span>
          )}
        </span>
      ) : (
        <span className="text-fg-quaternary">Select a task to see its acceptance verdicts.</span>
      )}
      <span className="flex-1" aria-hidden />
      {runNote ? <span className="truncate max-w-[40%] text-warning">{runNote}</span> : null}
    </footer>
  );
}
