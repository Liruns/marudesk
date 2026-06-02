import { useEffect } from 'react';
import { History, Plus, Trash2 } from 'lucide-react';
import type { ProviderId } from '../../../shared/providers';
import { cn } from '../../lib/cn';
import { ProviderGlyph } from '../providers/ProviderGlyph';
import { useAgentStore } from './store';

/**
 * Saved-session history list (v3 §5-C). A pure projection of the store's
 * `sessions`, shared by the full-surface {@link SessionRail} and the drawer's
 * history overlay. "New chat" resets the active conversation; clicking a row
 * resumes it (the loop swaps state + transcript); the hover-revealed trash
 * deletes it. The live conversation's row is highlighted via `activeSessionId`.
 *
 * `onPick` lets the drawer overlay close itself after a pick; the always-visible
 * rail leaves it unset.
 */
export function SessionList({ onPick, className }: { onPick?: () => void; className?: string }) {
  const sessions = useAgentStore((s) => s.sessions);
  const activeId = useAgentStore((s) => s.chat.activeSessionId);
  const loadSessions = useAgentStore((s) => s.loadSessions);
  const resumeSession = useAgentStore((s) => s.resumeSession);
  const deleteSession = useAgentStore((s) => s.deleteSession);
  const resetChat = useAgentStore((s) => s.resetChat);

  // Refresh on mount so the list reflects the latest persisted sessions whenever
  // the rail/overlay opens (a turn that finished while it was closed shows up).
  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div className="shrink-0 p-2">
        <button
          type="button"
          onClick={() => {
            void resetChat();
            onPick?.();
          }}
          className="flex w-full items-center gap-2 rounded-md border border-subtle px-2.5 py-1.5 text-body-sm text-fg-secondary transition-colors duration-fast hover:bg-surface-2 hover:text-fg-primary"
        >
          <Plus size={14} className="shrink-0" />
          <span>New chat</span>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-caption text-fg-tertiary">
            <History size={20} className="opacity-40" />
            <span>No saved chats yet.</span>
          </div>
        ) : (
          <ul>
            {sessions.map((s) => {
              const isActive = s.id === activeId;
              return (
                <li
                  key={s.id}
                  className={cn(
                    'group flex items-center gap-1 pr-1.5 transition-colors duration-fast',
                    isActive ? 'bg-surface-2' : 'hover:bg-surface-2/60',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      void resumeSession(s.id);
                      onPick?.();
                    }}
                    title={s.title}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left"
                  >
                    <ProviderGlyph provider={s.provider as ProviderId} label={s.model || s.provider} size={16} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span
                        className={cn(
                          'truncate text-body-sm',
                          isActive ? 'text-fg-primary' : 'text-fg-secondary',
                        )}
                      >
                        {s.title || 'Untitled chat'}
                      </span>
                      <span className="truncate text-caption text-fg-tertiary tabular-nums">
                        {relativeTime(s.updatedAt)} · {s.messageCount} msg
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteSession(s.id);
                    }}
                    aria-label={`Delete chat: ${s.title || 'Untitled chat'}`}
                    className="shrink-0 text-fg-tertiary/60 opacity-0 transition-opacity duration-fast hover:text-error group-hover:opacity-100"
                  >
                    <Trash2 size={13} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Compact relative timestamp for a session row ("3m ago", "2d ago", or a date). */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}
