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
      <div className="shrink-0 px-2 py-2">
        <button
          type="button"
          onClick={() => {
            void resetChat();
            onPick?.();
          }}
          className={cn(
            'flex w-full items-center gap-2 rounded border border-subtle',
            'px-2.5 py-1.5 text-body-sm text-fg-secondary',
            'transition-colors duration-fast',
            'hover:border-accent/50 hover:bg-surface-2 hover:text-fg-primary',
          )}
        >
          <Plus size={13} className="shrink-0 text-fg-tertiary" />
          <span>New chat</span>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center text-caption text-fg-tertiary">
            <History size={18} className="opacity-30" />
            <span className="leading-snug">No saved chats yet</span>
          </div>
        ) : (
          <ul className="py-1">
            {sessions.map((s) => {
              const isActive = s.id === activeId;
              return (
                <li
                  key={s.id}
                  className={cn(
                    'group flex items-center gap-1 pr-1 transition-colors duration-fast',
                    isActive
                      ? 'bg-surface-2 border-l-2 border-l-accent'
                      : 'border-l-2 border-l-transparent hover:bg-surface-2/50',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      void resumeSession(s.id);
                      onPick?.();
                    }}
                    title={s.title}
                    className="flex min-w-0 flex-1 items-center gap-2 pl-2.5 pr-1 py-1.5 text-left"
                  >
                    <ProviderGlyph provider={s.provider as ProviderId} label={s.model || s.provider} size={14} />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span
                        className={cn(
                          'truncate text-[0.8125rem] leading-snug',
                          isActive ? 'text-fg-primary font-medium' : 'text-fg-secondary',
                        )}
                      >
                        {s.title || 'Untitled chat'}
                      </span>
                      <span className="truncate text-[0.6875rem] leading-none text-fg-tertiary/70 tabular-nums">
                        {relativeTime(s.updatedAt)}
                        <span className="mx-1 opacity-50">·</span>
                        {s.messageCount} msg
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
                    className="shrink-0 p-1 rounded text-fg-tertiary/40 opacity-0 transition-all duration-fast hover:text-error hover:bg-error-subtle/30 group-hover:opacity-100"
                  >
                    <Trash2 size={12} />
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
