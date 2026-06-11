import { useEffect } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { BottomSheet } from '../../components/BottomSheet';
import { useAppStore } from '../../store/useAppStore';

/** Compact relative timestamp for a session row ("just now", "5m", "3h", "2d"). */
function timeAgo(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86_400)}d ago`;
}

/**
 * The saved conversations for the current scope (workspace or global), mirroring
 * the desktop session rail: tap one to resume it as the live chat (PC and phone
 * then share that conversation), or start a fresh one. The row matching
 * `chat.activeSessionId` is the conversation currently on screen.
 */
export function SessionsSheet({ onClose }: { readonly onClose: () => void }) {
  const sessions = useAppStore((s) => s.sessions);
  const sessionsLoading = useAppStore((s) => s.sessionsLoading);
  const activeSessionId = useAppStore((s) => s.chat.activeSessionId);
  const loadSessions = useAppStore((s) => s.loadSessions);
  const resumeSession = useAppStore((s) => s.resumeSession);
  const resetChat = useAppStore((s) => s.resetChat);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  return (
    <BottomSheet title="Chats" onClose={onClose}>
      <button
        type="button"
        className="picker-row picker-row--cta"
        onClick={() => {
          void resetChat();
          onClose();
        }}
      >
        <MessageSquarePlus size={16} className="picker-row__icon" />
        <span className="picker-row__label">New chat</span>
      </button>
      {(sessions ?? []).map((s) => {
        const live = s.id === activeSessionId;
        return (
          <button
            key={s.id}
            type="button"
            className={`picker-row picker-row--session${live ? ' picker-row--active' : ''}`}
            onClick={() => {
              void resumeSession(s.id);
              onClose();
            }}
          >
            <span className="picker-row__label">{s.title}</span>
            <span className="picker-row__meta">
              {live ? 'current · ' : ''}
              {timeAgo(s.updatedAt)} · {s.model} · {s.messageCount} msgs
            </span>
          </button>
        );
      })}
      {sessionsLoading && sessions === null && <div className="picker-empty">Loading…</div>}
      {!sessionsLoading && (sessions?.length ?? 0) === 0 && sessions !== null && (
        <div className="picker-empty">No saved chats here yet.</div>
      )}
    </BottomSheet>
  );
}
