import { useCallback, useEffect, useState } from 'react';
import { Database, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import type { StorageStats } from '../../../shared/context';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { toast } from '../../lib/toast';
import { Field, Section, Segmented } from './SettingsControls';
import { useSettingsStore } from './store';
import { useOnOffOptions } from './useLocalizedSettingsOptions';

/** Human-readable byte size (B / KB / MB) for the storage usage readout. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Data & Storage: manage what the app persists between launches. Each store is a
 * separate toggle (AI Chat sessions, open tabs); app settings themselves are
 * always saved (they're the record of these toggles) but can be reset or revealed
 * on disk. The usage readout shows which backend the session store uses (SQLite
 * when the native module loaded, else the JSON fallback) and its size.
 */
export function DataCategory() {
  const { t } = useI18n();
  const onOffOptions = useOnOffOptions();
  const storage = useSettingsStore((s) => s.settings.storage);
  const update = useSettingsStore((s) => s.update);
  const reset = useSettingsStore((s) => s.reset);
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshStats = useCallback(async () => {
    try {
      setStats(await window.marudesk.invoke('storage:stats'));
    } catch {
      setStats(null);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void window.marudesk
      .invoke('storage:stats')
      .then((s) => {
        if (alive) setStats(s);
      })
      .catch(() => {
        if (alive) setStats(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  const clearSessions = useCallback(async () => {
    if (!window.confirm(t('settings.data.clearSessions.confirm'))) return;
    setBusy(true);
    try {
      await window.marudesk.invoke('storage:clear-sessions');
      toast({
        title: t('settings.data.clearSessions.success'),
        variant: 'success',
      });
      await refreshStats();
    } catch {
      toast({ title: t('settings.data.clearSessions.error'), variant: 'error' });
    } finally {
      setBusy(false);
    }
  }, [refreshStats, t]);

  const sessionStorageHint = stats
    ? `${stats.backend === 'sqlite' ? t('settings.data.sessionStorage.sqlite') : t('settings.data.sessionStorage.json')} · ${t('settings.data.sessionStorage.sessionsPrefix')}${stats.sessionCount}${t('settings.data.sessionStorage.sessionsSuffix')} · ${formatBytes(stats.sessionBytes)}`
    : t('settings.data.sessionStorage.reading');

  return (
    <div className="flex flex-col gap-4">
      <Section>
        <Field
          label={t('settings.data.persistSessions.label')}
          hint={t('settings.data.persistSessions.hint')}
        >
          <Segmented
            value={storage.persistSessions ? 'on' : 'off'}
            options={onOffOptions}
            onChange={(v) => void update({ storage: { persistSessions: v === 'on' } })}
          />
        </Field>
        <Field
          label={t('settings.data.persistTabs.label')}
          hint={t('settings.data.persistTabs.hint')}
        >
          <Segmented
            value={storage.persistTabs ? 'on' : 'off'}
            options={onOffOptions}
            onChange={(v) => void update({ storage: { persistTabs: v === 'on' } })}
          />
        </Field>
      </Section>

      <Section>
        <Field
          label={t('settings.data.sessionStorage.label')}
          hint={sessionStorageHint}
        >
          <button
            type="button"
            onClick={() => void refreshStats()}
            className={cn(
              'inline-flex items-center gap-1.5 h-8 px-3 rounded-md',
              'text-body-sm text-fg-secondary bg-surface-2',
              'hover:text-fg-primary hover:bg-surface-3 transition-colors duration-fast',
            )}
          >
            <RefreshCw size={14} />
            {t('settings.data.refresh')}
          </button>
        </Field>
        <Field
          label={t('settings.data.clearSessions.label')}
          hint={t('settings.data.clearSessions.hint')}
        >
          <button
            type="button"
            disabled={busy}
            onClick={() => void clearSessions()}
            className={cn(
              'inline-flex items-center gap-1.5 h-8 px-3 rounded-md',
              'text-body-sm text-error bg-surface-2',
              'hover:bg-surface-3 transition-colors duration-fast',
              busy && 'opacity-50 pointer-events-none',
            )}
          >
            <Trash2 size={14} />
            {t('settings.data.clearSessions.button')}
          </button>
        </Field>
        <Field
          label={t('settings.data.folder.label')}
          hint={t('settings.data.folder.hint')}
        >
          <button
            type="button"
            onClick={() => void window.marudesk.invoke('storage:reveal')}
            className={cn(
              'inline-flex items-center gap-1.5 h-8 px-3 rounded-md',
              'text-body-sm text-fg-secondary bg-surface-2',
              'hover:text-fg-primary hover:bg-surface-3 transition-colors duration-fast',
            )}
          >
            <Database size={14} />
            {t('settings.data.folder.open')}
          </button>
        </Field>
      </Section>

      <Section>
        <Field
          label={t('settings.data.reset.label')}
          hint={t('settings.data.reset.hint')}
        >
          <button
            type="button"
            onClick={() => {
              if (window.confirm(t('settings.data.reset.confirm'))) void reset();
            }}
            className={cn(
              'inline-flex items-center gap-1.5 h-8 px-3 rounded-md',
              'text-body-sm text-fg-secondary bg-surface-2',
              'hover:text-fg-primary hover:bg-surface-3 transition-colors duration-fast',
            )}
          >
            <RotateCcw size={14} />
            {t('settings.data.reset.button')}
          </button>
        </Field>
      </Section>
    </div>
  );
}
