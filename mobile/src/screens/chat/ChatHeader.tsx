import { RotateCcw, User } from 'lucide-react';
import { BrandGlyph } from '../../components/Brand';
import { AgentStatusBadge, ConnectionChip } from '../../components/StatusBadge';
import type { AgentChatState } from '../../types';
import type { TransportStatusInfo } from '../../transport';

export function ChatHeader({
  chat,
  status,
  busy,
  onAccount,
  onReset,
}: {
  readonly chat: AgentChatState;
  readonly status: TransportStatusInfo;
  readonly busy: boolean;
  readonly onAccount: () => void;
  readonly onReset: () => void;
}) {
  const canReset = chat.messages.length > 0 && !busy;

  return (
    <header className="chat-header">
      <div className="chat-header__brand">
        <BrandGlyph size={34} />
        <div className="chat-header__titles">
          <div className="chat-header__title">AI Chat</div>
          <div className="chat-header__meta">
            <AgentStatusBadge status={chat.status} />
            <ConnectionChip info={status} />
          </div>
        </div>
      </div>
      <div className="chat-header__actions">
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
