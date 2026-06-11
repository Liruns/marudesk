import { AgentChat } from './AgentChat';
import { SessionRail } from './SessionRail';
import { AgentScopeProvider } from './store';
import type { WorkspaceId } from '../../../shared/workspace';

/**
 * The full-surface AI Chat — the `agent` tab kind (v3 §5-B, Antigravity/Claude/
 * Codex Desktop parity). Hosts {@link AgentChat} in its wide, centered `full`
 * variant. The tab and drawer share one conversation within the same workspace,
 * while sibling workspaces keep independent chat/session projections.
 */
export function AgentTab({ workspaceId }: { workspaceId?: WorkspaceId }) {
  return (
    <AgentScopeProvider workspaceId={workspaceId}>
      {/* @container: the chat surface adapts to its PANE width (split view /
          divider drags), not the viewport — children use @[…rem]: variants. */}
      <div className="flex-1 min-w-0 flex flex-row min-h-0 bg-surface-page @container">
        <SessionRail />
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          <AgentChat variant="full" />
        </div>
      </div>
    </AgentScopeProvider>
  );
}
