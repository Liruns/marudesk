import { Spinner } from '../../components/ui';
import { useWorkGraphStore } from './store';

/**
 * Mission Control flight status, shown in the title bar's center (the "flight
 * bar"): the active goal + run progress (done / total, failures). Renders
 * nothing until a graph exists, so legacy surfaces keep a clean drag region.
 */
export function FlightStatus() {
  const graph = useWorkGraphStore((s) => s.graph);
  const running = useWorkGraphStore((s) => s.running);
  if (!graph) return null;
  const total = graph.tasks.length;
  const done = graph.tasks.filter((t) => t.status === 'done').length;
  const failed = graph.tasks.filter((t) => t.status === 'failed').length;
  return (
    <div className="flex min-w-0 items-center gap-2 text-caption tabular-nums text-fg-tertiary">
      <span aria-hidden className="size-1.5 shrink-0 rounded-pill bg-accent" />
      <span className="truncate max-w-[min(48vw,420px)] text-fg-secondary" title={graph.goal}>
        {graph.goal || 'Untitled flight'}
      </span>
      {running ? <Spinner size={11} label="Running" /> : null}
      <span className="shrink-0">
        {done}/{total} done
      </span>
      {failed > 0 ? <span className="shrink-0 text-error">{failed} failed</span> : null}
    </div>
  );
}
