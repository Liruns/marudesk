import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { MessageBubble } from '../components/MessageBubble';
import { ApprovalPrompt } from '../components/ApprovalPrompt';
import { PlanBoard } from '../components/PlanBoard';
import { QuestionPrompt } from '../components/QuestionPrompt';
import { Composer } from '../components/Composer';
import { ChatHeader } from './chat/ChatHeader';
import { CommandErrorBanner, ConnectionBanner, EmptyState, ThinkingRow } from './chat/ChatStates';
import { usePullToReconnect } from './chat/usePullToReconnect';

const DEFAULT_PROVIDER = 'anthropic';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

export function ChatScreen() {
  const chat = useAppStore((s) => s.chat);
  const status = useAppStore((s) => s.status);
  const setRoute = useAppStore((s) => s.setRoute);
  const sendPrompt = useAppStore((s) => s.sendPrompt);
  const abort = useAppStore((s) => s.abort);
  const approve = useAppStore((s) => s.approve);
  const respond = useAppStore((s) => s.respond);
  const resetChat = useAppStore((s) => s.resetChat);
  const reconnect = useAppStore((s) => s.reconnect);
  const commandError = useAppStore((s) => s.commandError);
  const clearCommandError = useAppStore((s) => s.clearCommandError);

  const [actionBusy, setActionBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pullRef = usePullToReconnect(() => void reconnect());

  const busy = chat.status === 'thinking' || chat.status === 'working';
  const connected = status.status === 'connected';
  const composerDisabled = !connected || chat.pendingApproval !== null || chat.pendingQuestions !== null;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [chat.messages, chat.status, chat.pendingApproval, chat.pendingQuestions]);

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
            return <MessageBubble key={m.id} message={m} streaming={isLastAssistant && busy} />;
          })
        )}

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

      <Composer
        busy={busy}
        disabled={composerDisabled}
        onSend={(text) => void sendPrompt(text, DEFAULT_PROVIDER, DEFAULT_MODEL)}
        onStop={() => void abort()}
      />
    </div>
  );
}
