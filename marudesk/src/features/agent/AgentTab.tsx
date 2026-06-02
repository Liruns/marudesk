import { AgentChat } from './AgentChat';
import { SessionRail } from './SessionRail';

/**
 * The full-surface AI Chat — the `agent` tab kind (v3 §5-B, Antigravity/Claude/
 * Codex Desktop parity). Hosts {@link AgentChat} in its wide, centered `full`
 * variant. The same single agent conversation also appears in the compact
 * {@link ContextDrawer} companion beside the browser; both are pure projections
 * of the one server-owned `AgentChatState`, so opening this tab never forks the
 * conversation — it's the same chat, roomier.
 */
export function AgentTab() {
  return (
    <div className="flex-1 min-w-0 flex flex-row min-h-0 bg-surface-page">
      <SessionRail />
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <AgentChat variant="full" />
      </div>
    </div>
  );
}
