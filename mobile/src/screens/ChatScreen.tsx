import { useEffect, useMemo, useRef, useState } from 'react';
import { Cpu } from 'lucide-react';
import type { RemoteEditDiff } from '../types';
import { useAppStore } from '../store/useAppStore';
import { MessageBubble } from '../components/MessageBubble';
import { ApprovalPrompt } from '../components/ApprovalPrompt';
import { EditDiffCard } from '../components/EditDiffCard';
import { ApprovalModeToggle } from '../components/ApprovalModeToggle';
import { PlanBoard } from '../components/PlanBoard';
import { QuestionPrompt } from '../components/QuestionPrompt';
import { Composer } from '../components/Composer';
import { ChatHeader } from './chat/ChatHeader';
import { CommandErrorBanner, ConnectionBanner, EmptyState, ThinkingRow } from './chat/ChatStates';
import { ModelSheet } from './chat/ModelSheet';
import { SessionsSheet } from './chat/SessionsSheet';
import { WorkspaceSheet } from './chat/WorkspaceSheet';
import { attachEditsToMessages } from './chat/turnEdits';
import { usePullToReconnect } from './chat/usePullToReconnect';

type SheetKind = 'none' | 'workspace' | 'sessions' | 'model';

export function ChatScreen() {
  const chat = useAppStore((s) => s.chat);
  const status = useAppStore((s) => s.status);
  const setRoute = useAppStore((s) => s.setRoute);
  const sendPrompt = useAppStore((s) => s.sendPrompt);
  const abort = useAppStore((s) => s.abort);
  const approve = useAppStore((s) => s.approve);
  const respond = useAppStore((s) => s.respond);
  const resetChat = useAppStore((s) => s.resetChat);
  const revertEdit = useAppStore((s) => s.revertEdit);
  const reconnect = useAppStore((s) => s.reconnect);
  const commandError = useAppStore((s) => s.commandError);
  const clearCommandError = useAppStore((s) => s.clearCommandError);
  const catalogReady = useAppStore((s) => s.catalogReady);
  const workspaces = useAppStore((s) => s.workspaces);
  const workspaceId = useAppStore((s) => s.workspaceId);
  const provider = useAppStore((s) => s.provider);
  const model = useAppStore((s) => s.model);

  const [actionBusy, setActionBusy] = useState(false);
  const [sheet, setSheet] = useState<SheetKind>('none');
  const scrollRef = useRef<HTMLDivElement>(null);
  const pullRef = usePullToReconnect(() => void reconnect());

  const busy = chat.status === 'thinking' || chat.status === 'working';
  const connected = status.status === 'connected';
  // Anchor the PC-projected edit diffs under the turn that produced them.
  const editAnchors = useMemo(
    () => attachEditsToMessages(chat.messages, chat.editDiffs ?? []),
    [chat.messages, chat.editDiffs],
  );
  const onRevert = (editId: string) => void withBusy(() => revertEdit(editId))();
  const renderEdits = (edits: RemoteEditDiff[] | undefined) =>
    edits?.map((e) => <EditDiffCard key={e.id} edit={e} busy={actionBusy} onRevert={onRevert} />);
  const composerDisabled = !connected || chat.pendingApproval !== null || chat.pendingQuestions !== null;
  const workspaceName = workspaces.find((w) => w.id === workspaceId)?.name ?? null;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [chat.messages, chat.status, chat.pendingApproval, chat.pendingQuestions, chat.editDiffs]);

  const withBusy = (fn: () => Promise<void>) => async () => {
    setActionBusy(true);
    try {
      await fn();
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <div className="chat-screen">
      <ChatHeader
        chat={chat}
        status={status}
        busy={busy}
        workspaceName={workspaceName}
        canPick={connected && catalogReady}
        onOpenWorkspaces={() => setSheet('workspace')}
        onOpenSessions={() => setSheet('sessions')}
        onAccount={() => setRoute('account')}
        onReset={withBusy(resetChat)}
      />
      <div
        ref={(node) => {
          scrollRef.current = node;
          pullRef(node);
        }}
        className="chat-scroll"
      >
        {!connected && <ConnectionBanner status={status.status} onReconnect={() => void reconnect()} />}

        {chat.error && (
          <div className="chat-error">{chat.error}</div>
        )}

        {chat.messages.length === 0 ? (
          <EmptyState connected={connected} />
        ) : (
          chat.messages.map((m, i) => {
            const isLastAssistant = i === chat.messages.length - 1 && m.role === 'assistant';
            return (
              <div key={m.id}>
                <MessageBubble message={m} streaming={isLastAssistant && busy} />
                {renderEdits(editAnchors.byMessageId.get(m.id))}
              </div>
            );
          })
        )}
        {renderEdits(editAnchors.trailing.length > 0 ? editAnchors.trailing : undefined)}

        {chat.status === 'thinking' && <ThinkingRow />}
      </div>

      {commandError && <CommandErrorBanner message={commandError} onDismiss={clearCommandError} />}

      {chat.plan && <PlanBoard plan={chat.plan} />}

      {chat.pendingApproval && (
        <ApprovalPrompt approval={chat.pendingApproval} busy={actionBusy} onDecision={(ok) => void withBusy(() => approve(ok))()} />
      )}
      {chat.pendingQuestions && (
        <QuestionPrompt pending={chat.pendingQuestions} busy={actionBusy} onSubmit={(a) => void withBusy(() => respond(a))()} />
      )}

      {connected && (
        <div className="composer-toolbar">
          {catalogReady ? (
            <button
              type="button"
              className="chip-button"
              aria-label="Model and reasoning"
              onClick={() => setSheet('model')}
            >
              <Cpu size={13} />
              <span className="chip-button__label">{model || provider}</span>
              <span className="chip-button__sub">{chat.reasoningEffort}</span>
            </button>
          ) : (
            <span />
          )}
          <ApprovalModeToggle disabled={actionBusy} />
        </div>
      )}

      <Composer
        busy={busy}
        disabled={composerDisabled}
        onSend={(text) => void sendPrompt(text)}
        onStop={() => void abort()}
      />

      {sheet === 'workspace' && <WorkspaceSheet onClose={() => setSheet('none')} />}
      {sheet === 'sessions' && <SessionsSheet onClose={() => setSheet('none')} />}
      {sheet === 'model' && <ModelSheet onClose={() => setSheet('none')} />}
    </div>
  );
}
