import { useCallback, useEffect, useState } from 'react';
import {
  Download,
  ExternalLink,
  GitBranch,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import type {
  AppInfo,
  UpdateCheckResult,
  UpdateCheckUnavailableReason,
} from '../../../shared/app-info';
import type { TranslationKey } from '../../i18n/messages';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { toast } from '../../lib/toast';
import { useUpdateStatus } from '../../hooks/useUpdateStatus';
import { Field, Section } from './SettingsControls';
import { useSettingsStore } from './store';

function unavailableMessageKey(
  reason: UpdateCheckUnavailableReason,
): TranslationKey {
  switch (reason) {
    case 'invalid-response':
      return 'settings.about.updates.unavailable.invalid-response';
    case 'network-error':
      return 'settings.about.updates.unavailable.network-error';
    case 'no-release':
      return 'settings.about.updates.unavailable.no-release';
  }
}

export function AboutCategory() {
  const { t } = useI18n();
  const reset = useSettingsStore((s) => s.reset);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const autoStatus = useUpdateStatus();

  useEffect(() => {
    let alive = true;
    void window.marudesk
      .invoke('app:info')
      .then((info) => {
        if (alive) setAppInfo(info);
      })
      .catch(() => {
        if (alive) setAppInfo(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  const checkForUpdates = useCallback(async () => {
    setChecking(true);
    try {
      const result = await window.marudesk.invoke('app:check-for-updates');
      setUpdateCheck(result);
      if (result.kind === 'available') {
        toast({
          title: t('settings.about.updates.toast.available'),
          description: `${t('settings.about.updates.available.before')}${result.latestVersion}${t('settings.about.updates.available.after')}`,
          variant: 'success',
        });
      } else if (result.kind === 'up-to-date') {
        toast({
          title: t('settings.about.updates.toast.upToDate'),
          description: `${t('settings.about.updates.upToDate.before')}${result.latestVersion}${t('settings.about.updates.upToDate.after')}`,
          variant: 'success',
        });
      } else {
        toast({
          title: t('settings.about.updates.toast.unavailable'),
          description: t(unavailableMessageKey(result.reason)),
          variant: 'error',
        });
      }
    } catch {
      toast({
        title: t('settings.about.updates.toast.unavailable'),
        description: t('settings.about.updates.unavailable.network-error'),
        variant: 'error',
      });
    } finally {
      setChecking(false);
    }
  }, [t]);

  const updateHint = checking
    ? t('settings.about.updates.checking')
    : updateCheck?.kind === 'available'
      ? `${t('settings.about.updates.available.before')}${updateCheck.latestVersion}${t('settings.about.updates.available.after')}`
      : updateCheck?.kind === 'up-to-date'
        ? `${t('settings.about.updates.upToDate.before')}${updateCheck.latestVersion}${t('settings.about.updates.upToDate.after')}`
        : updateCheck?.kind === 'unavailable'
          ? t(unavailableMessageKey(updateCheck.reason))
          : t('settings.about.updates.idle');

  // The in-app auto-updater (Windows) takes precedence over the manual-check hint
  // once it is actively downloading or has staged an update.
  const autoHint =
    autoStatus.kind === 'downloading'
      ? `${t('settings.about.updates.auto.downloading')} (${autoStatus.percent}%)`
      : autoStatus.kind === 'downloaded'
        ? `${t('settings.about.updates.auto.downloaded.before')}${autoStatus.version}${t('settings.about.updates.auto.downloaded.after')}`
        : autoStatus.kind === 'error'
          ? t('settings.about.updates.auto.error')
          : null;

  return (
    <Section>
      <Field label={t('settings.about.version')}>
        <span className="text-body-sm font-mono text-fg-secondary">
          {appInfo?.version ?? t('settings.about.version.loading')}
        </span>
      </Field>
      <Field label={t('settings.about.runtime')}>
        <span className="text-body-sm font-mono text-fg-secondary">
          Electron - React - TypeScript
        </span>
      </Field>
      <Field
        label={t('settings.about.security')}
        hint="contextIsolation - sandboxed renderer - safeStorage keys"
      >
        <span className="text-caption text-fg-tertiary">
          {t('settings.about.hardened')}
        </span>
      </Field>
      <Field
        label={t('settings.about.github.label')}
        hint={t('settings.about.github.hint')}
      >
        <button
          type="button"
          onClick={() => void window.marudesk.invoke('app:open-github')}
          className={cn(
            'inline-flex items-center gap-1.5 h-8 px-3 rounded-md',
            'text-body-sm text-fg-secondary bg-surface-2',
            'hover:text-fg-primary hover:bg-surface-3 transition-colors duration-fast',
          )}
        >
          <GitBranch size={14} />
          {t('settings.about.github.button')}
        </button>
      </Field>
      <Field
        label={t('settings.about.updates.label')}
        hint={autoHint ?? updateHint}
      >
        <div className="flex items-center gap-2">
          {autoStatus.kind === 'downloaded' ? (
            <button
              type="button"
              onClick={() =>
                void window.marudesk.invoke('app:quit-and-install')
              }
              className={cn(
                'inline-flex items-center gap-1.5 h-8 px-3 rounded-md',
                'text-body-sm text-fg-primary bg-accent',
                'hover:bg-accent-hover transition-colors duration-fast',
              )}
            >
              <Download size={14} />
              {t('settings.about.updates.auto.restart')}
            </button>
          ) : null}
          {updateCheck?.kind === 'available' &&
          autoStatus.kind === 'disabled' ? (
            <button
              type="button"
              onClick={() => void window.marudesk.invoke('app:open-releases')}
              className={cn(
                'inline-flex items-center gap-1.5 h-8 px-3 rounded-md',
                'text-body-sm text-fg-primary bg-accent',
                'hover:bg-accent-hover transition-colors duration-fast',
              )}
            >
              <ExternalLink size={14} />
              {t('settings.about.releases.button')}
            </button>
          ) : null}
          <button
            type="button"
            disabled={checking}
            onClick={() => void checkForUpdates()}
            className={cn(
              'inline-flex items-center gap-1.5 h-8 px-3 rounded-md',
              'text-body-sm text-fg-secondary bg-surface-2',
              'hover:text-fg-primary hover:bg-surface-3 transition-colors duration-fast',
              checking && 'opacity-50 pointer-events-none',
            )}
          >
            <RefreshCw
              size={14}
              className={checking ? 'animate-spin' : undefined}
            />
            {checking
              ? t('settings.about.updates.button.checking')
              : t('settings.about.updates.button.check')}
          </button>
        </div>
      </Field>
      <Field
        label={t('settings.data.reset.label')}
        hint={t('settings.about.reset.hint')}
      >
        <button
          type="button"
          onClick={() => {
            if (window.confirm(t('settings.data.reset.confirm'))) {
              void reset();
            }
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
  );
}
