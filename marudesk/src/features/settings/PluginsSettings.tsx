import { useEffect, useState } from 'react';
import {
  Blocks,
  FolderPlus,
  FolderOpen,
  Loader2,
  RotateCcw,
} from 'lucide-react';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n/useI18n';
import type { PluginStatus } from '../../../shared/plugin';
import { PluginCard } from './PluginCard';

/**
 * Settings → Plugins (docs/plugin-runtime-design.md §7 P2). Lists user/project
 * plugins with their state, declared permissions, and contributed tool/command
 * counts, with enable/install/remove actions. Enabling a plugin grants the
 * permissions shown on its card and spawns its isolated worker; every contributed
 * tool routes through the same loop approval/read-only mediation as built-ins.
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

  const installFromFolder = async () => {
    setBusy(true);
    try {
      setPlugins(await window.marudesk.invoke('plugins:install-folder'));
    } catch {
      // Keep the current list; cancel/failure leaves state unchanged.
    } finally {
      setBusy(false);
    }
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

  const remove = async (id: string) => {
    if (!window.confirm(t('settings.plugins.removeConfirm'))) return;
    setBusy(true);
    try {
      setPlugins(await window.marudesk.invoke('plugins:remove', { id }));
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
          leadingIcon={busy ? <Loader2 size={14} className="animate-spin" /> : <FolderPlus size={14} />}
          onClick={() => void installFromFolder()}
          disabled={busy}
        >
          {t('settings.plugins.installFolder')}
        </Button>
        <Button
          variant="ghost"
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
          plugins.map((p) => (
            <PluginCard key={p.id} status={p} busy={busy} onToggle={toggle} onRemove={remove} />
          ))
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
