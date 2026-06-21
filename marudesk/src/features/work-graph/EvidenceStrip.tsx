import { cn } from '../../lib/cn';
import type { Criterion } from '../../../shared/work-os';
import { useWorkGraphStore } from './store';

const VERDICT_DOT: Record<Criterion['verdict'], string> = {
  unknown: 'bg-fg-tertiary',
  pass: 'bg-success',
  fail: 'bg-error',
};

/**
 * Mission Control's bottom Evidence strip — the runtime "black box" summary for
 * the selected Task: its acceptance verdicts (system-filled from the live app)
 * and the latest run note. Replaces the legacy StatusBar on this surface; a Task
 * is only "verified" when the running app proves its criteria.
 */
export function EvidenceStrip() {
  const graph = useWorkGraphStore((s) => s.graph);
  const selectedTaskId = useWorkGraphStore((s) => s.selectedTaskId);
  const runNote = useWorkGraphStore((s) => s.runNote);
  const task = graph?.tasks.find((t) => t.id === selectedTaskId);
  const passed = task ? task.acceptance.filter((c) => c.verdict === 'pass').length : 0;

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
            <span className="flex shrink-0 items-center gap-1.5">
              <span className="flex items-center gap-0.5">
                {task.acceptance.map((c) => (
                  <span key={c.id} aria-hidden className={cn('size-1.5 rounded-pill', VERDICT_DOT[c.verdict])} />
                ))}
              </span>
              <span>
                {passed}/{task.acceptance.length} verified by runtime
              </span>
            </span>
          ) : (
            <span className="shrink-0 text-fg-tertiary/70">no acceptance criteria</span>
          )}
        </span>
      ) : (
        <span className="text-fg-tertiary/70">Select a task to see its runtime evidence.</span>
      )}
      <span className="flex-1" aria-hidden />
      {runNote ? <span className="truncate max-w-[40%] text-warning">{runNote}</span> : null}
    </footer>
  );
}
