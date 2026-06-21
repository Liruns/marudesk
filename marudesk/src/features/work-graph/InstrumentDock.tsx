import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { Spinner } from '../../components/ui';
import { AgentChat } from '../agent/AgentChat';
import { AgentScopeProvider } from '../agent/store';
import type { WorkspaceId } from '../../../shared/workspace';
import { useWorkspaceDeckStore } from '../workspaces/store';
import { useWorkGraphStore } from './store';
import { WorkGraphInspectorContent } from './WorkGraphInspector';
import { acquireTaskThread, setDockRenderedThread, taskThreadId } from './taskThreads';

/**
 * The per-task chat: bound to the selected task's OWN agent thread (acquired once,
 * reused across re-selection) so each node owns an independent conversation. Held
 * back behind a spinner until the thread resolves so it never briefly shows
 * another task's transcript (mirrors AgentTab); if the thread can't be acquired it
 * falls back to the workspace conversation so the dock is never stuck. Keyed by
 * task id at the call site, so switching tasks remounts this with fresh state —
 * the reset is the remount, not a synchronous setState in an effect.
 */
function TaskChat({ taskId, workspaceId }: { taskId: string; workspaceId?: WorkspaceId }) {
  const [threadId, setThreadId] = useState<string | undefined>(() => taskThreadId(taskId) ?? undefined);
  const [resolved, setResolved] = useState<boolean>(() => taskThreadId(taskId) !== null);

  useEffect(() => {
    let cancelled = false;
    void acquireTaskThread(taskId, workspaceId).then((id) => {
      if (cancelled) return;
      setThreadId(id ?? undefined);
      setResolved(true);
    });
    return () => {
      cancelled = true;
    };
  }, [taskId, workspaceId]);

  // Publish the thread the dock is ACTUALLY rendering so Shell can suppress the
  // "AI finished" toast for it. The bound case publishes the task's own thread;
  // the fallback case (acquire failed ⇒ threadId undefined) publishes the
  // workspace's active conversation — the thread AgentChat follows when unbound —
  // refreshed on the workspace's thread-list pushes so a later active-thread
  // switch stays suppressed. Cleared on unmount/deselect so a background
  // completion still toasts once the dock is gone.
  useEffect(() => {
    if (!resolved) return;
    if (threadId) {
      setDockRenderedThread(threadId);
      return () => setDockRenderedThread(null);
    }
    let cancelled = false;
    const refresh = () => {
      void window.marudesk
        .invoke('agent:list-threads', workspaceId ? { workspaceId } : {})
        .then((threads) => {
          if (cancelled) return;
          setDockRenderedThread(threads.find((th) => th.active)?.id ?? null);
        })
        .catch(() => {});
    };
    refresh();
    // A workspace-scoped dock follows its workspace's thread list; an unscoped
    // one (no open workspace) follows the global list. Re-resolve the active
    // thread when that list changes so the suppressed id tracks active-thread
    // switches.
    const off = workspaceId
      ? window.marudesk.on('agent:workspace-threads', (event) => {
          if (event.workspaceId === workspaceId) refresh();
        })
      : window.marudesk.on('agent:threads', () => refresh());
    return () => {
      cancelled = true;
      off();
      setDockRenderedThread(null);
    };
  }, [resolved, threadId, workspaceId]);

  if (!resolved) {
    return (
      <div className="grid flex-1 place-items-center">
        <Spinner size={16} label="Opening task conversation" />
      </div>
    );
  }
  return (
    <AgentScopeProvider workspaceId={workspaceId} threadId={threadId}>
      <AgentChat />
    </AgentScopeProvider>
  );
}

/**
 * Mission Control's Instrument Dock (docs/mission-control-redesign.md, Phase 2):
 * the right-hand surface that is EMPTY until a Task is selected, then shows that
 * task's inspector (intent / acceptance / evidence / diff) on top and the agent
 * conversation below it — "you talk to the task, not a global bot." Selecting a
 * different node swaps the content; deselecting collapses the dock to nothing.
 *
 * Phase 2b: the chat below is scoped per-task (see {@link TaskChat}).
 */
export function InstrumentDock() {
  const selectedTaskId = useWorkGraphStore((s) => s.selectedTaskId);
  const open = selectedTaskId !== null;
  const activeWorkspaceId = useWorkspaceDeckStore((s) => s.activeWorkspaceId);

  return (
    <aside
      aria-label="Task instrument dock"
      aria-hidden={!open}
      className={cn(
        'chrome-panel relative shrink-0 border-y-0 border-r-0 overflow-hidden',
        'transition-[width] duration-standard',
      )}
      style={{ width: open ? '22.5rem' : 0, maxWidth: 'calc(100vw - 3rem)' }}
    >
      {/* Only mount the content (incl. focusable chat) while open — keeps the
          collapsed, aria-hidden dock free of tab-reachable controls. Fixed inner
          width so the width animation doesn't reflow content. */}
      {open && selectedTaskId ? (
        <div className="h-full flex flex-col" style={{ width: '22.5rem' }}>
          <div className="h-[44%] shrink-0 overflow-hidden border-b border-subtle">
            <WorkGraphInspectorContent />
          </div>
          <div className="min-h-0 flex-1 flex flex-col">
            <TaskChat
              key={selectedTaskId}
              taskId={selectedTaskId}
              workspaceId={activeWorkspaceId ?? undefined}
            />
          </div>
        </div>
      ) : null}
    </aside>
  );
}
