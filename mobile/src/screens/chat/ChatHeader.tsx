import { ChevronDown, History, RotateCcw, User } from 'lucide-react';
import { BrandGlyph } from '../../components/Brand';
import { AgentStatusBadge, ConnectionChip } from '../../components/StatusBadge';
import type { AgentChatState } from '../../types';
import type { TransportStatusInfo } from '../../transport';

export function ChatHeader({
  chat,
  status,
  busy,
  workspaceName,
  canPick,
  onOpenWorkspaces,
  onOpenSessions,
  onAccount,
  onReset,
}: {
  readonly chat: AgentChatState;
  readonly status: TransportStatusInfo;
  readonly busy: boolean;
  /** Display name of the pinned PC workspace, or null for the global chat. */
  readonly workspaceName: string | null;
  /** True when the PC catalog is loaded, enabling the workspace/sessions pickers. */
  readonly canPick: boolean;
  readonly onOpenWorkspaces: () => void;
  readonly onOpenSessions: () => void;
  readonly onAccount: () => void;
  readonly onReset: () => void;
}) {
  const canReset = chat.messages.length > 0 && !busy;

  return (
    <header className="chat-header">
      <div className="chat-header__brand">
        <BrandGlyph size={34} />
        <button
          type="button"
          className="chat-header__titles chat-header__titles--button"
          onClick={onOpenWorkspaces}
          disabled={!canPick}
          aria-label="Pick a workspace"
        >
          <div className="chat-header__title">
            {workspaceName ?? 'AI Chat'}
            {canPick && <ChevronDown size={14} className="chat-header__caret" />}
          </div>
          <div className="chat-header__meta">
            <AgentStatusBadge status={chat.status} />
            <ConnectionChip info={status} />
          </div>
        </button>
      </div>
      <div className="chat-header__actions">
        <button
          className="icon-button"
          aria-label="Chats"
          onClick={onOpenSessions}
          disabled={!canPick}
        >
          <History size={19} />
        </button>
        <button
          className="icon-button"
          aria-label="Reset conversation"
          onClick={onReset}
          disabled={!canReset}
        >
          <RotateCcw size={19} />
        </button>
        <button className="icon-button" aria-label="Account" onClick={onAccount}>
          <User size={20} />
        </button>
      </div>
    </header>
  );
}
