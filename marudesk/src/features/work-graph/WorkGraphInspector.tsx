import { ExternalLink, Hammer, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useSurfaceStore } from '../canvas/surface';
import type { Criterion, Resource, Task } from '../../../shared/work-os';
import { useWorkGraphStore } from './store';
import { toast } from '../../lib/toast';
import { parseUnifiedDiff } from '../git/parseDiff';
import { DiffBlock } from '../../components/ui';

/**
 * The Work OS supervision panel: the selected Task's intent, acceptance criteria
 * (with system-filled verdicts), and — after a run — the agent's evidence result.
 * Resources open as tool surfaces on the canvas (the dedicated dock is a later
 * slice) so "tools open FROM a node, not inside it" holds.
 */

const VERDICT_DOT: Record<Criterion['verdict'], string> = {
  unknown: 'bg-fg-tertiary',
  pass: 'bg-success',
  fail: 'bg-error',
};

/** Open a Resource as a real tool surface (canvas card), keyed by its uri scheme. */
function openResource(r: Resource): void {
  const uri = r.uri;
  let opened = false;
  if (/^https?:\/\//.test(uri)) {
    void window.marudesk.invoke('browser:tabs-new', { kind: 'web', url: uri });
    opened = true;
  } else if (uri.startsWith('file://')) {
    const raw = uri.replace(/^file:\/\/\/?/, '').replace(/#.*$/, '');
    // A malformed percent-escape makes decodeURI throw — fall back to the raw path.
    let path: string;
    try {
      path = decodeURI(raw);
    } catch {
      path = raw;
    }
    if (path) {
      void window.marudesk.invoke('browser:tabs-new', { kind: 'editor', path });
      opened = true;
    }
  } else if (uri.startsWith('term://')) {
    void window.marudesk.invoke('browser:tabs-new', { kind: 'terminal' });
    opened = true;
  }
  // The resource opens on the canvas surface (the Work OS tool dock is a later
  // slice); switch there so the user actually sees it.
  if (opened) useSurfaceStore.getState().setMode('canvas');
  else toast({ title: 'No opener for this resource type', variant: 'warning' });
}

export function WorkGraphInspector() {
  const graph = useWorkGraphStore((s) => s.graph);
  const selectedTaskId = useWorkGraphStore((s) => s.selectedTaskId);
  const running = useWorkGraphStore((s) => s.running);
  const task: Task | undefined = graph?.tasks.find((t) => t.id === selectedTaskId);
  if (!task) return null;

  const result = task.evidence?.result;
  const patch = task.evidence?.patch;
  const taskId = task.id;
  // parseUnifiedDiff is bounded (caps at 600 lines); compute inline — no hook needed.
  const diffLines = patch ? parseUnifiedDiff(patch) : [];

  return (
    <div className="absolute right-3 top-14 bottom-16 z-50 flex w-80 flex-col overflow-hidden rounded-lg chrome-panel p-3 shadow-card">
      <div className="mb-2 flex items-start gap-2">
        <div className="min-w-0">
          <p className="truncate text-body-sm font-medium text-fg-primary">{task.title}</p>
          <p className="text-caption text-fg-tertiary">
            {task.status}
            {task.executor.type === 'agent' ? ` · @${task.executor.ref}` : ' · human'}
            {task.kind === 'decision' ? ' · decision' : ''}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close inspector"
          onClick={() => useWorkGraphStore.getState().selectTask(null)}
          className="ml-auto grid h-5 w-5 shrink-0 place-items-center rounded text-fg-tertiary hover:bg-surface-3 hover:text-fg-primary"
        >
          <X size={13} />
        </button>
      </div>

      <button
        type="button"
        disabled={running}
        onClick={() => void useWorkGraphStore.getState().implementTask(taskId)}
        title="Run a write-capable agent in a throwaway git worktree and capture the diff — your files are never touched"
        className="mb-2 inline-flex items-center gap-1.5 self-start rounded-md bg-accent px-2.5 py-1 text-caption font-medium text-white hover:bg-accent-hover disabled:opacity-60"
      >
        <Hammer size={12} />
        Implement (isolated)
      </button>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {task.intent ? <p className="text-caption text-fg-secondary">{task.intent}</p> : null}

        {task.acceptance.length > 0 ? (
          <div>
            <p className="mb-1 text-caption font-medium text-fg-secondary">Acceptance</p>
            <ul className="space-y-1">
              {task.acceptance.map((c) => (
                <li key={c.id} className="flex items-start gap-1.5 text-caption text-fg-tertiary">
                  <span className={cn('mt-1 h-2 w-2 shrink-0 rounded-pill', VERDICT_DOT[c.verdict])} aria-hidden />
                  <span>{c.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div>
          <p className="mb-1 text-caption font-medium text-fg-secondary">Result</p>
          {result ? (
            <pre className="whitespace-pre-wrap break-words rounded-md bg-surface-2 p-2 text-caption text-fg-secondary">
              {result}
            </pre>
          ) : (
            <p className="text-caption text-fg-tertiary">Not run yet.</p>
          )}
        </div>

        {patch ? (
          <div>
            <p className="mb-1 text-caption font-medium text-fg-secondary">Proposed changes (diff)</p>
            <DiffBlock filePath="Proposed changes" lines={diffLines} className="max-h-64 overflow-auto" />
            <p className="mt-1 text-caption text-fg-tertiary">
              Produced in a throwaway worktree — your files are unchanged. Review before applying.
            </p>
          </div>
        ) : null}

        {task.outputs.length > 0 ? (
          <div>
            <p className="mb-1 text-caption font-medium text-fg-secondary">Resources</p>
            <div className="flex flex-wrap gap-1.5">
              {task.outputs.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => openResource(r)}
                  title={r.uri}
                  className="inline-flex items-center gap-1 rounded-pill bg-surface-2 px-2 py-0.5 text-caption text-fg-secondary hover:bg-surface-3 hover:text-accent"
                >
                  <ExternalLink size={11} />
                  <span className="max-w-[10rem] truncate">{r.label ?? r.uri}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
