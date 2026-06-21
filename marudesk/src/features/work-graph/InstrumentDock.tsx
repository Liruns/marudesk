import { cn } from '../../lib/cn';
import { AgentChat } from '../agent/AgentChat';
import { AgentScopeProvider } from '../agent/store';
import { useWorkspaceDeckStore } from '../workspaces/store';
import { useWorkGraphStore } from './store';
import { WorkGraphInspectorContent } from './WorkGraphInspector';

/**
 * Mission Control's Instrument Dock (docs/mission-control-redesign.md, Phase 2):
 * the right-hand surface that is EMPTY until a Task is selected, then shows that
 * task's inspector (intent / acceptance / evidence / diff) on top and the agent
 * conversation below it — "you talk to the task, not a global bot." Selecting a
 * different node swaps the content; deselecting collapses the dock to nothing.
 *
 * Phase 2 hosts the inspector + chat. A later slice re-hosts the live
 * instruments (browser / Monaco / terminal) here via the WebContentsView bounds
 * pipeline, and scopes the chat per-task rather than per-workspace.
 */
export function InstrumentDock() {
  const open = useWorkGraphStore((s) => s.selectedTaskId !== null);
  const activeWorkspaceId = useWorkspaceDeckStore((s) => s.activeWorkspaceId);

  return (
    <aside
      aria-label="Task instrument dock"
      aria-hidden={!open}
      className={cn(
        'chrome-panel relative shrink-0 border-y-0 border-r-0 overflow-hidden',
        'transition-[width] duration-standard',
      )}
      style={{ width: open ? 360 : 0, maxWidth: 'calc(100vw - 3rem)' }}
    >
      {/* Only mount the content (incl. focusable chat) while open — keeps the
          collapsed, aria-hidden dock free of tab-reachable controls. Fixed inner
          width so the width animation doesn't reflow content. */}
      {open ? (
        <div className="h-full flex flex-col" style={{ width: 360 }}>
          <div className="h-[44%] shrink-0 overflow-hidden border-b border-subtle">
            <WorkGraphInspectorContent />
          </div>
          <div className="min-h-0 flex-1 flex flex-col">
            <AgentScopeProvider workspaceId={activeWorkspaceId ?? undefined}>
              <AgentChat />
            </AgentScopeProvider>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
