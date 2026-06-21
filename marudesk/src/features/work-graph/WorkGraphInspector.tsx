import { Check, ExternalLink, FileText, Hammer, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { Criterion, Resource, Task } from '../../../shared/work-os';
import type { TabKind } from '../../../shared/browser';
import type { WorkspaceId } from '../../../shared/workspace';
import { useI18n } from '../../i18n/useI18n';
import { useTabsStore } from '../tabs/store';
import { useInstrumentStore } from './instrument';
import { taskThreadWorkspaceId } from './taskThreads';
import { useWorkspaceDeckStore } from '../workspaces/store';
import { useWorkGraphStore } from './store';
import { toast } from '../../lib/toast';
import { changedFilePaths, parseUnifiedDiff } from '../git/parseDiff';
import { openFileInstrument } from './instrument';
import type { WorkspaceFileRef } from '../../../shared/workspace';
import { DiffBlock, Spinner, Badge } from '../../components/ui';
import { STATUS_BADGE, STATUS_LABEL_KEY } from './status';

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

/**
 * Open a Resource as a live instrument that fills Mission Control's main area
 * (the runtime-aware browser gets full real estate), keyed by its uri scheme.
 * The tab is created + activated so its surface/native view shows, then pinned
 * as the active instrument; "← Graph" closes it back to the Task graph.
 */
async function openResource(r: Resource, noOpenerMessage: string, workspaceId?: WorkspaceId): Promise<void> {
  const uri = r.uri;
  let kind: TabKind | null = null;
  let id: string | null = null;
  if (/^https?:\/\//.test(uri)) {
    kind = 'web';
    id = await window.marudesk.invoke('browser:tabs-new', { kind: 'web', url: uri, workspaceId });
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
      kind = 'editor';
      id = await window.marudesk.invoke('browser:tabs-new', { kind: 'editor', path, workspaceId });
    }
  } else if (uri.startsWith('term://')) {
    kind = 'terminal';
    id = await window.marudesk.invoke('browser:tabs-new', { kind: 'terminal', workspaceId });
  }
  if (kind && id) {
    await useTabsStore.getState().activateTab(id);
    // A cancelled dirty-editor prompt keeps the previous instrument and rejects
    // this id — close the resource tab we just created so it doesn't leak as a
    // hidden orphan (live WebContentsView that can never be torn down).
    if (!useInstrumentStore.getState().open(id, kind)) {
      await useTabsStore.getState().closeTab(id);
    }
  } else {
    toast({ title: noOpenerMessage, variant: 'warning' });
  }
}

/**
 * The inspector's inner content (header + Implement + intent/acceptance/result/
 * diff/resources), filling its container. Shared by the floating overlay (legacy
 * canvas surface) and the Mission Control Instrument Dock.
 */
export function WorkGraphInspectorContent() {
  const { t } = useI18n();
  const graph = useWorkGraphStore((s) => s.graph);
  const selectedTaskId = useWorkGraphStore((s) => s.selectedTaskId);
  const running = useWorkGraphStore((s) => s.running);
  const applyingPatchTaskId = useWorkGraphStore((s) => s.applyingPatchTaskId);
  const task: Task | undefined = graph?.tasks.find((t) => t.id === selectedTaskId);
  if (!task) return null;

  const result = task.evidence?.result;
  const patch = task.evidence?.patch;
  const taskId = task.id;
  // Resources open in the task's own workspace (via its bound conversation thread),
  // mirroring the ⌘K openInstrument path. Fall back to the active workspace when the
  // task isn't bound yet so nothing regresses.
  const resourceWorkspaceId =
    taskThreadWorkspaceId(taskId) ?? useWorkspaceDeckStore.getState().activeWorkspaceId ?? undefined;
  // parseUnifiedDiff is bounded (caps at 600 lines); compute inline — no hook needed.
  const diffLines = patch ? parseUnifiedDiff(patch) : [];
  // Each changed file in the diff is openable as the editor instrument so a
  // reviewer can jump from "see diff" to the real workspace file (the CURRENT,
  // pre-apply version — a before/after reference), reusing Search/SCM's hop.
  const changedFiles = patch ? changedFilePaths(patch) : [];
  // Resolve a changed path to its bound workspace + root (mirrors SearchPanel);
  // fall back to the bare path so main resolves it against the active workspace.
  const boundWorkspace = resourceWorkspaceId
    ? useWorkspaceDeckStore.getState().workspaces.find((w) => w.id === resourceWorkspaceId) ?? null
    : null;
  const openChangedFile = (path: string): void => {
    const rootId = boundWorkspace?.activeRootId ?? boundWorkspace?.roots[0]?.id ?? null;
    const target: WorkspaceFileRef | string =
      boundWorkspace && rootId ? { workspaceId: boundWorkspace.id, rootId, path } : path;
    void openFileInstrument(target);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden p-3">
      <div className="mb-2 flex items-start gap-2">
        <div className="min-w-0">
          <p className="truncate text-body-sm font-medium text-fg-primary">{task.title}</p>
          <div className="mt-0.5 flex items-center gap-1.5">
            <Badge variant={STATUS_BADGE[task.status]}>{t(STATUS_LABEL_KEY[task.status])}</Badge>
            <p className="text-caption text-fg-tertiary">{task.executor.type === 'agent' ? `@${task.executor.ref}` : t('workGraph.inspector.executorHuman')}{task.kind === 'decision' ? t('workGraph.inspector.decisionSuffix') : ''}</p>
          </div>
        </div>
        <button
          type="button"
          aria-label={t('workGraph.inspector.closeInspector')}
          onClick={() => useWorkGraphStore.getState().selectTask(null)}
          className="ml-auto grid h-5 w-5 shrink-0 place-items-center rounded text-fg-tertiary hover:bg-surface-3 hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none transition-colors duration-fast active:scale-[0.99]"
        >
          <X size={13} />
        </button>
      </div>

      <button
        type="button"
        disabled={running}
        onClick={() => void useWorkGraphStore.getState().implementTask(taskId)}
        title={t('workGraph.inspector.implementTitle')}
        className="mb-2 inline-flex items-center gap-1.5 self-start rounded bg-accent px-2.5 py-1 text-caption font-medium text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none active:scale-[0.99] transition-colors duration-fast"
      >
        {running ? <Spinner size={13} label={t('workGraph.inspector.implementing')} /> : <Hammer size={12} />}
        {t('workGraph.inspector.implement')}
      </button>
      {task.status === 'planned' && !result ? (
        <p className="mt-0.5 text-caption text-fg-tertiary">{t('workGraph.inspector.isolatedHint')}</p>
      ) : null}

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 pb-4">
        {task.intent ? <p className="text-caption text-fg-secondary">{task.intent}</p> : null}

        {task.acceptance.length > 0 ? (
          <div>
            <p className="mb-2 text-caption font-medium text-fg-secondary">{t('workGraph.inspector.acceptance')}</p>
            <ul className="space-y-1">
              {task.acceptance.map((c) => (
                <li key={c.id} className="flex items-start gap-1.5 text-caption text-fg-tertiary">
                  <span className={cn('pt-[3px] h-2 w-2 shrink-0 rounded-pill', VERDICT_DOT[c.verdict])} aria-hidden />
                  <span>{c.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {(result || running) ? (
          <div>
            <p className="mb-2 text-caption font-medium text-fg-secondary">{t('workGraph.inspector.result')}</p>
            {result ? (
              <pre className="whitespace-pre-wrap break-words rounded bg-surface-3 shadow-inset-soft p-2 font-mono text-caption text-fg-secondary">
                {result}
              </pre>
            ) : (
              <div className="flex items-center gap-1.5 text-caption text-fg-tertiary">
                <Spinner size={12} label={t('workGraph.inspector.runningLabel')} />
                {t('workGraph.inspector.running')}
              </div>
            )}
          </div>
        ) : null}

        {patch ? (
          <div>
            <p className="mb-2 text-caption font-medium text-fg-secondary">{t('workGraph.inspector.proposedChanges')}</p>
            {changedFiles.length > 0 ? (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {changedFiles.map((path) => (
                  <button
                    key={path}
                    type="button"
                    onClick={() => openChangedFile(path)}
                    title={t('workGraph.inspector.openFileTitle').replace('{path}', path)}
                    className="inline-flex items-center gap-1 rounded-pill bg-surface-2 border border-subtle px-2 py-0.5 text-caption text-fg-secondary hover:bg-surface-3 hover:text-accent hover:border-default focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none active:scale-[0.99] transition-colors duration-fast"
                  >
                    <FileText size={11} />
                    <span className="max-w-[12rem] truncate">{path}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <DiffBlock filePath="Proposed changes" lines={diffLines} className="max-h-[min(256px,40vh)] overflow-auto" />
            <p className="mt-1 text-caption text-fg-tertiary">
              {t('workGraph.inspector.throwawayNote')}
            </p>
            <button
              type="button"
              disabled={running || applyingPatchTaskId !== null}
              onClick={() => void useWorkGraphStore.getState().applyPatch(taskId)}
              title={t('workGraph.inspector.applyTitle')}
              className="mt-2 inline-flex items-center gap-1.5 self-start rounded bg-surface-2 border border-default px-2.5 py-1 text-caption font-medium text-fg-primary hover:bg-surface-3 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none active:scale-[0.99] transition-colors duration-fast"
            >
              {applyingPatchTaskId === taskId ? <Spinner size={13} label={t('workGraph.inspector.applyingLabel')} /> : <Check size={12} />}
              {t('workGraph.inspector.applyToWorkspace')}
            </button>
          </div>
        ) : null}

        {task.outputs.length > 0 ? (
          <div>
            <p className="mb-2 text-caption font-medium text-fg-secondary">{t('workGraph.inspector.resources')}</p>
            <div className="flex flex-wrap gap-1.5">
              {task.outputs.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => void openResource(r, t('workGraph.inspector.noOpener'), resourceWorkspaceId)}
                  title={r.uri}
                  className="inline-flex items-center gap-1 rounded-pill bg-surface-2 border border-subtle px-2 py-0.5 text-caption text-fg-secondary hover:bg-surface-3 hover:text-accent hover:border-default focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none active:scale-[0.99] transition-colors duration-fast"
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

/**
 * Floating overlay variant, anchored bottom-right of the legacy canvas surface.
 * Mission Control renders {@link WorkGraphInspectorContent} inside the Instrument
 * Dock instead, so the inspector is a docked panel there, not a floater.
 */
export function WorkGraphInspector() {
  const has = useWorkGraphStore(
    (s) => s.selectedTaskId !== null && (s.graph?.tasks.some((t) => t.id === s.selectedTaskId) ?? false),
  );
  if (!has) return null;
  return (
    <div className="absolute right-4 top-14 bottom-16 z-50 w-80 overflow-hidden rounded-lg chrome-panel shadow-card motion-safe:animate-scale-in">
      <WorkGraphInspectorContent />
    </div>
  );
}
