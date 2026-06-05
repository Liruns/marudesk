import { useEffect, useState } from 'react';
import {
  AlertCircle,
  Blocks,
  CheckCircle2,
  CircleSlash,
  FolderOpen,
  Loader2,
  PanelRight,
  RotateCcw,
  ShieldAlert,
} from 'lucide-react';
import { Badge, Button } from '../../components/ui';
import { cn } from '../../lib/cn';
import { useI18n } from '../../i18n/useI18n';
import type { PluginStatus } from '../../../shared/plugin';
import { useTabsStore } from '../tabs/store';

/**
 * Settings → Plugins (docs/plugin-runtime-design.md §7 P2). Lists user/project
 * plugins with their state, declared permissions, and contributed tool/command
 * counts, with an enable toggle and a Reload action. Enabling a plugin grants the
 * permissions shown on its card and spawns its isolated worker; every tool it
 * contributes is routed through the same loop approval/read-only mediation as the
 * built-in tools. A new plugin is added by dropping a folder into the plugins
 * directory and hitting Reload.
 */
export function PluginsSettings() {
  const { t } = useI18n();
  const [plugins, setPlugins] = useState<PluginStatus[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.marudesk
      .invoke('plugins:list')
      .then((list) => {
        if (alive) setPlugins(list);
      })
      .catch(() => {
        if (alive) setPlugins([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const reload = async () => {
    setBusy(true);
    try {
      setPlugins(await window.marudesk.invoke('plugins:reload'));
    } catch {
      // Keep the current list; a transient failure shouldn't blank the panel.
    } finally {
      setBusy(false);
    }
  };

  const openPluginsFolder = () => {
    void window.marudesk.invoke('plugins:open-folder').catch(() => {});
  };

  const toggle = async (id: string, enabled: boolean) => {
    setBusy(true);
    try {
      setPlugins(await window.marudesk.invoke('plugins:set-enabled', { id, enabled }));
    } catch {
      // no-op — the list stays as-is
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-caption text-fg-tertiary">{t('settings.plugins.description')}</p>

      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          leadingIcon={busy ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
          onClick={() => void reload()}
          disabled={busy}
        >
          {t('settings.plugins.reload')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<FolderOpen size={14} />}
          onClick={openPluginsFolder}
        >
          {t('settings.plugins.openFolder')}
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        {plugins === null ? (
          <EmptyRow text={t('settings.plugins.loading')} />
        ) : plugins.length === 0 ? (
          <EmptyRow text={t('settings.plugins.empty')} />
        ) : (
          plugins.map((p) => <PluginCard key={p.id} status={p} busy={busy} onToggle={toggle} />)
        )}
      </div>
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-subtle bg-surface-1 px-4 py-3 text-body-sm text-fg-tertiary">
      <Blocks size={15} className="shrink-0" />
      <span>{text}</span>
    </div>
  );
}

function PluginCard({
  status,
  busy,
  onToggle,
}: {
  status: PluginStatus;
  busy: boolean;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
}) {
  const { t } = useI18n();
  const openPluginPanel = useTabsStore((s) => s.openPluginPanel);
  const on = status.state === 'active';
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-subtle bg-surface-1 px-4 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-body-sm font-medium text-fg-primary truncate">{status.name}</span>
          <StatusBadge status={status} />
          <span className="text-caption uppercase tracking-wide text-fg-tertiary/70 shrink-0">{status.scope}</span>
          <span className="text-caption font-mono text-fg-tertiary/70 shrink-0">v{status.version}</span>
        </div>
        {status.permissions.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-caption text-fg-tertiary">{t('settings.plugins.permissions')}:</span>
            {status.permissions.map((perm) => (
              <span
                key={perm}
                className="rounded-pill bg-surface-3 px-1.5 py-0.5 text-caption font-mono text-fg-secondary"
              >
                {perm}
              </span>
            ))}
          </div>
        ) : null}
        {status.state === 'error' && status.error ? (
          <span className="text-caption text-error truncate">{status.error}</span>
        ) : null}
      </div>
      {status.panel ? (
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<PanelRight size={14} />}
          onClick={() => void openPluginPanel(status.id, status.panel!.entry)}
        >
          {t('settings.plugins.openPanel')}
        </Button>
      ) : null}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`${on ? t('settings.plugins.toggle.disable') : t('settings.plugins.toggle.enable')} ${status.name}`}
        disabled={busy}
        onClick={() => void onToggle(status.id, !on)}
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-pill transition-colors duration-fast',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          on ? 'bg-accent' : 'bg-surface-3',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 size-4 rounded-full bg-white transition-transform duration-fast',
            on ? 'translate-x-[18px]' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  );
}

function StatusBadge({ status }: { status: PluginStatus }) {
  const { t } = useI18n();
  if (status.state === 'active') {
    return (
      <Badge variant="success" className="gap-1">
        <CheckCircle2 size={11} />
        {t('settings.plugins.status.active')}
      </Badge>
    );
  }
  if (status.state === 'needs-approval') {
    return (
      <Badge variant="accent" className="gap-1">
        <ShieldAlert size={11} />
        {t('settings.plugins.status.needsApproval')}
      </Badge>
    );
  }
  if (status.state === 'error') {
    return (
      <Badge variant="error" className="gap-1">
        <AlertCircle size={11} />
        {t('settings.plugins.status.error')}
      </Badge>
    );
  }
  return (
    <Badge variant="neutral" className="gap-1">
      <CircleSlash size={11} />
      {t('settings.plugins.status.disabled')}
    </Badge>
  );
}
