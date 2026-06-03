import { useEffect, useRef, useState } from 'react';
import { User, RotateCcw, Sparkles, RefreshCw, Loader2 } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { MessageBubble } from '../components/MessageBubble';
import { ApprovalPrompt } from '../components/ApprovalPrompt';
import { QuestionPrompt } from '../components/QuestionPrompt';
import { Composer } from '../components/Composer';
import { AgentStatusBadge, ConnectionChip } from '../components/StatusBadge';
import { BrandGlyph } from '../components/Brand';

/** A sensible default agent target; the PC validates against its real registry. */
const DEFAULT_PROVIDER = 'anthropic';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

/**
 * Step 3 — the AI Chat surface. Renders the PC-owned AgentChatState: streaming
 * message list, tool cards, inline approval + ask_user prompts, and a
 * bottom-anchored composer. The phone never runs the model; every action is a
 * transport command.
 */
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

  // Auto-scroll to the newest content whenever the projection changes.
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* header */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: 'calc(var(--safe-top) + 10px) 14px 10px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-elev)',
          flexShrink: 0,
        }}
      >
        <BrandGlyph size={32} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>AI Chat</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <AgentStatusBadge status={chat.status} />
            <span style={{ color: 'var(--border-strong)' }}>·</span>
            <ConnectionChip info={status} />
          </div>
        </div>
        <button
          className="btn-ghost"
          aria-label="Reset conversation"
          style={{ width: 40, height: 40, display: 'grid', placeItems: 'center' }}
          onClick={withBusy(resetChat)}
          disabled={chat.messages.length === 0 || busy}
        >
          <RotateCcw size={19} />
        </button>
        <button
          className="btn-ghost"
          aria-label="Account"
          style={{ width: 40, height: 40, display: 'grid', placeItems: 'center' }}
          onClick={() => setRoute('account')}
        >
          <User size={20} />
        </button>
      </header>

      {/* message list */}
      <div
        ref={(node) => {
          scrollRef.current = node;
          pullRef(node);
        }}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: 8 }}
      >
        {!connected && <ConnectionBanner status={status.status} onReconnect={() => void reconnect()} />}

        {chat.error && (
          <div style={{ margin: '12px 14px', padding: 12, borderRadius: 'var(--radius)', background: 'var(--danger-soft)', color: 'var(--danger)', fontSize: 14 }}>
            {chat.error}
          </div>
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

      {/* a failed command (e.g. the desktop refusing a remote gated-tool approval) */}
      {commandError && <CommandErrorBanner message={commandError} onDismiss={clearCommandError} />}

      {/* gated interactions sit directly above the composer */}
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

/* ── empty / loading / disconnected states ───────────────────────────────── */

function EmptyState({ connected }: { connected: boolean }) {
  return (
    <div
      style={{
        height: '100%',
        minHeight: 320,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        padding: 32,
        textAlign: 'center',
      }}
    >
      <div style={{ width: 64, height: 64, borderRadius: 20, background: 'var(--accent-soft)', display: 'grid', placeItems: 'center' }}>
        <Sparkles size={30} style={{ color: 'var(--accent)' }} />
      </div>
      <div style={{ fontWeight: 700, fontSize: 18 }}>Ask your PC's agent</div>
      <p className="muted" style={{ margin: 0, fontSize: 14.5, maxWidth: 300, lineHeight: 1.5 }}>
        {connected
          ? 'Send a message and watch it work — with the running app in view. Tool calls, approvals and questions appear here.'
          : 'Once your PC is online, send a message and watch it work right here.'}
      </p>
    </div>
  );
}

function ThinkingRow() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 18px 12px', color: 'var(--thinking)' }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: 'currentColor',
            animation: 'dots 1.2s infinite ease-in-out',
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
      <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>thinking…</span>
    </div>
  );
}

function CommandErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        margin: '0 14px 8px',
        padding: '10px 12px',
        borderRadius: 'var(--radius)',
        background: 'var(--danger-soft)',
        color: 'var(--danger)',
        fontSize: 13.5,
        lineHeight: 1.45,
      }}
      role="alert"
    >
      <span style={{ flex: 1, minWidth: 0 }}>{message}</span>
      <button
        className="btn-ghost"
        aria-label="Dismiss"
        style={{ fontSize: 13, fontWeight: 700, color: 'var(--danger)', padding: 0 }}
        onClick={onDismiss}
      >
        Dismiss
      </button>
    </div>
  );
}

function ConnectionBanner({ status, onReconnect }: { status: string; onReconnect: () => void }) {
  const connecting = status === 'connecting';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        margin: '12px 14px 4px',
        padding: '10px 14px',
        borderRadius: 'var(--radius)',
        background: 'var(--bg-elev-2)',
        border: '1px solid var(--border)',
      }}
    >
      {connecting ? <Loader2 size={16} className="spin muted" /> : <RefreshCw size={16} className="muted" />}
      <span style={{ flex: 1, fontSize: 13.5, color: 'var(--fg-muted)' }}>
        {connecting ? 'Connecting to your PC…' : 'Not connected to your PC.'}
      </span>
      {!connecting && (
        <button className="btn-ghost" style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent)', padding: 0 }} onClick={onReconnect}>
          Retry
        </button>
      )}
    </div>
  );
}

/* ── pull-to-reconnect ───────────────────────────────────────────────────── */

/**
 * Lightweight pull-to-refresh: when the list is scrolled to the very top and the
 * user drags down past a threshold, fire `onPull` (reconnect). Returns a ref
 * callback to attach to the scroll container. Touch-only; no-op with a mouse.
 */
function usePullToReconnect(onPull: () => void): (node: HTMLDivElement | null) => void {
  const ref = useRef<HTMLDivElement | null>(null);
  const startY = useRef<number | null>(null);

  return (node: HTMLDivElement | null) => {
    if (ref.current === node) return;
    if (ref.current) {
      ref.current.ontouchstart = null;
      ref.current.ontouchmove = null;
      ref.current.ontouchend = null;
    }
    ref.current = node;
    if (!node) return;

    node.ontouchstart = (e: TouchEvent) => {
      startY.current = node.scrollTop <= 0 ? e.touches[0]!.clientY : null;
    };
    node.ontouchmove = (e: TouchEvent) => {
      if (startY.current === null) return;
      const dy = e.touches[0]!.clientY - startY.current;
      if (dy > 90) {
        startY.current = null;
        onPull();
      }
    };
    node.ontouchend = () => {
      startY.current = null;
    };
  };
}
