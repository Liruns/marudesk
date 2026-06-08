import { useCallback, useEffect, useState } from 'react';
import { Brain, ChevronDown, ChevronRight, RefreshCw, Save, Search, Trash2 } from 'lucide-react';
import type { MemoryEntry } from '../../../shared/context';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { toast } from '../../lib/toast';
import { Section } from './SettingsControls';

/**
 * Memory controls (v5 §G5): see what the agent has remembered across sessions,
 * edit a note's body, or delete one. The agent reads/writes these via its
 * list/read/write_memory tools; this surface gives the user the same control
 * (transparency + the ability to correct or forget), which the agent had no UI
 * for before. One row per stored note; expand to view/edit the markdown body.
 */
export function MemorySettings() {
  const { t } = useI18n();
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [query, setQuery] = useState('');
  const [openName, setOpenName] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  // Query-aware load (v6 §W3): full-text search across note bodies when a query is
  // present, otherwise the full recency-ordered list.
  const refresh = useCallback(async () => {
    try {
      const q = query.trim();
      setEntries(
        q
          ? await window.marudesk.invoke('memory:search', { query: q })
          : await window.marudesk.invoke('memory:list'),
      );
    } catch {
      setEntries([]);
    }
  }, [query]);

  // Re-runs on mount and whenever the query changes (refresh closes over query).
  useEffect(() => {
    let alive = true;
    void (async () => {
      const q = query.trim();
      try {
        const e = q
          ? await window.marudesk.invoke('memory:search', { query: q })
          : await window.marudesk.invoke('memory:list');
        if (alive) setEntries(e);
      } catch {
        if (alive) setEntries([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [query]);

  const open = useCallback(async (name: string) => {
    if (openName === name) {
      setOpenName(null);
      return;
    }
    setOpenName(name);
    setBody('');
    try {
      const full = await window.marudesk.invoke('memory:read', { name });
      setBody(full?.body ?? '');
    } catch {
      setBody('');
    }
  }, [openName]);

  const save = useCallback(async (name: string) => {
    setBusy(true);
    try {
      const res = await window.marudesk.invoke('memory:write', { name, body });
      if (res.ok) {
        toast({
          title: t('settings.memory.saved'),
          description: res.evicted && res.evicted.length > 0 ? t('settings.memory.evicted') : undefined,
          variant: 'success',
        });
        await refresh();
      } else {
        toast({ title: t('settings.memory.saveFailed'), description: res.reason, variant: 'error' });
      }
    } catch {
      toast({ title: t('settings.memory.saveFailed'), variant: 'error' });
    } finally {
      setBusy(false);
    }
  }, [body, refresh, t]);

  const remove = useCallback(async (name: string) => {
    if (!window.confirm(t('settings.memory.deleteConfirm'))) return;
    setBusy(true);
    try {
      await window.marudesk.invoke('memory:delete', { name });
      if (openName === name) setOpenName(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [openName, refresh, t]);

  return (
    <Section>
      <div className="flex items-center gap-2">
        <Brain size={15} className="text-fg-tertiary" />
        <span className="text-body-sm font-medium text-fg-primary">{t('settings.memory.title')}</span>
        <span className="text-caption text-fg-tertiary">{t('settings.memory.hint')}</span>
        <button
          type="button"
          onClick={() => void refresh()}
          className="ml-auto inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-body-sm text-fg-secondary bg-surface-2 hover:text-fg-primary hover:bg-surface-3 transition-colors duration-fast"
        >
          <RefreshCw size={14} />
          {t('settings.memory.refresh')}
        </button>
      </div>

      <div className="relative">
        <Search
          size={14}
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-tertiary"
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('settings.memory.searchPlaceholder')}
          className="h-8 w-full rounded-md bg-surface-2 pl-8 pr-3 text-body-sm text-fg-primary outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      {entries.length === 0 ? (
        <p className="text-body-sm text-fg-tertiary">
          {query.trim() ? t('settings.memory.noMatches') : t('settings.memory.empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {entries.map((entry) => {
            const isOpen = openName === entry.name;
            return (
              <li key={entry.name} className="rounded border border-subtle bg-surface-1">
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => void open(entry.name)}
                    className="flex flex-1 items-center gap-2 min-w-0 text-left"
                  >
                    {isOpen ? (
                      <ChevronDown size={14} className="shrink-0 text-fg-tertiary" />
                    ) : (
                      <ChevronRight size={14} className="shrink-0 text-fg-tertiary" />
                    )}
                    <span className="font-mono text-caption text-fg-secondary truncate">{entry.name}</span>
                    {!isOpen ? (
                      <span className="truncate text-caption text-fg-tertiary">{entry.preview}</span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove(entry.name)}
                    title={t('settings.memory.delete')}
                    aria-label={t('settings.memory.delete')}
                    className="shrink-0 p-1 text-fg-tertiary hover:text-error transition-colors duration-fast"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                {isOpen ? (
                  <div className="flex flex-col gap-1.5 border-t border-subtle p-2">
                    <textarea
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      rows={6}
                      className="w-full resize-y rounded bg-surface-2 p-2 font-mono text-caption text-fg-primary outline-none focus:ring-1 focus:ring-accent"
                    />
                    <div className="flex justify-end">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void save(entry.name)}
                        className={cn(
                          'inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-body-sm text-fg-secondary bg-surface-2',
                          'hover:text-fg-primary hover:bg-surface-3 transition-colors duration-fast',
                          busy && 'opacity-50 pointer-events-none',
                        )}
                      >
                        <Save size={14} />
                        {t('settings.memory.save')}
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
