import { Fragment, useEffect, useState } from 'react';
import { History, Plus, Search, Trash2 } from 'lucide-react';
import type { ProviderId } from '../../../shared/providers';
import type { SessionSearchHit } from '../../../shared/context';
import { cn } from '../../lib/cn';
import type { I18nContextValue } from '../../i18n/useI18n';
import { useI18n } from '../../i18n/useI18n';
import { ProviderGlyph } from '../providers/ProviderGlyph';
import { useAgentStore, useAgentWorkspaceId } from './store';

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
  const { t } = useI18n();
  const sessions = useAgentStore((s) => s.sessions);
  const activeId = useAgentStore((s) => s.chat.activeSessionId);
  const loadSessions = useAgentStore((s) => s.loadSessions);
  const resumeSession = useAgentStore((s) => s.resumeSession);
  const deleteSession = useAgentStore((s) => s.deleteSession);
  const resetChat = useAgentStore((s) => s.resetChat);
  const workspaceId = useAgentWorkspaceId();
  const [filter, setFilter] = useState('');
  // Backend full-text results (title + transcript) — null while not searching, so
  // the resting list is the store's recent `sessions`.
  const [hits, setHits] = useState<SessionSearchHit[] | null>(null);

  // Refresh on mount so the list reflects the latest persisted sessions whenever
  // the rail/overlay opens (a turn that finished while it was closed shows up).
  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  // Debounced full-text search over the saved transcripts (FTS5 when SQLite is
  // active, a substring scan on the JSON fallback). An empty query clears back to
  // the recent list. Stale responses are dropped via the `cancelled` guard.
  useEffect(() => {
    const q = filter.trim();
    let cancelled = false;
    // Run all state updates inside the (async) timeout callback so none fire
    // synchronously in the effect body. An empty query clears back to recents.
    const timer = setTimeout(
      () => {
        if (!q) {
          setHits(null);
          return;
        }
        void window.marudesk
          .invoke('agent:search-sessions', { query: q, workspaceId })
          .then((res) => {
            if (!cancelled) setHits(res);
          })
          .catch(() => {
            if (!cancelled) setHits([]);
          });
      },
      q ? 200 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [filter, workspaceId]);

  const searching = hits !== null;
  const visible: SessionSearchHit[] = hits ?? sessions;

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
          <span>{t('agent.sessions.newChat')}</span>
        </button>
        {sessions.length > 0 ? (
          <div className="mt-2 flex items-center gap-1.5 h-7 rounded bg-surface-page border border-subtle px-2 focus-within:border-accent">
            <Search size={12} className="shrink-0 text-fg-tertiary" aria-hidden />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('agent.sessions.search.placeholder')}
              spellCheck={false}
              aria-label={t('agent.sessions.search.aria')}
              className="flex-1 min-w-0 bg-transparent text-caption text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
            />
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center text-caption text-fg-tertiary">
            <History size={18} className="opacity-30" />
            <span className="leading-snug">{t('agent.sessions.empty')}</span>
          </div>
        ) : searching && visible.length === 0 ? (
          <div className="px-4 py-8 text-center text-caption text-fg-tertiary">
            {t('agent.sessions.noMatchBefore')}
            {filter.trim()}
            {t('agent.sessions.noMatchAfter')}
          </div>
        ) : (
          <ul className="py-1">
            {visible.map((s) => {
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
                        {s.title || t('agent.sessions.untitled')}
                      </span>
                      <span className="truncate text-[0.6875rem] leading-none text-fg-tertiary/70 tabular-nums">
                        {relativeTime(s.updatedAt, t)}
                        <span className="mx-1 opacity-50">·</span>
                        {s.messageCount}
                        {s.messageCount === 1
                          ? t('agent.sessions.messageSingular')
                          : t('agent.sessions.messagePlural')}
                      </span>
                      {s.snippet ? (
                        <span className="line-clamp-2 text-[0.6875rem] leading-snug text-fg-tertiary">
                          <Snippet text={s.snippet} />
                        </span>
                      ) : null}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteSession(s.id);
                    }}
                    aria-label={`${t('agent.sessions.deleteBefore')}${s.title || t(
                      'agent.sessions.untitled',
                    )}${t('agent.sessions.deleteAfter')}`}
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

/**
 * Render an FTS snippet, highlighting the matched terms. The store delimits each
 * match with ⟦…⟧, so we split on those markers — odd segments are the matches.
 */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/⟦|⟧/);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="bg-transparent text-accent font-medium">
            {part}
          </mark>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/** Compact relative timestamp for a session row ("3m ago", "2d ago", or a date). */
function relativeTime(ts: number, t: I18nContextValue['t']): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return t('agent.sessions.justNow');
  if (m < 60) return `${m}${t('agent.sessions.minutesAgo')}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}${t('agent.sessions.hoursAgo')}`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}${t('agent.sessions.daysAgo')}`;
  return new Date(ts).toLocaleDateString();
}
