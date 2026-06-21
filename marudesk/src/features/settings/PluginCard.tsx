import {
  AlertCircle,
  CheckCircle2,
  CircleSlash,
  PanelRight,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import type { PluginStatus } from '../../../shared/plugin';
import { Badge, Button, Switch } from '../../components/ui';
import { useI18n } from '../../i18n/useI18n';
import { useTabsStore } from '../tabs/store';

type PluginCardProps = {
  status: PluginStatus;
  busy: boolean;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
};

export function PluginCard({ status, busy, onToggle, onRemove }: PluginCardProps) {
  const { t } = useI18n();
  const openPluginPanel = useTabsStore((s) => s.openPluginPanel);
  const on = status.state === 'active';
  const panel = status.panel;
  const canRemove = status.scope === 'user' || status.hasUserInstall === true;

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-subtle bg-surface-1 px-4 py-2">
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

      <div className="flex shrink-0 items-center gap-2">
        {panel ? (
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={<PanelRight size={14} />}
            onClick={() => void openPluginPanel(status.id, panel.entry)}
          >
            {t('settings.plugins.openPanel')}
          </Button>
        ) : null}
        {canRemove ? (
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={<Trash2 size={14} />}
            onClick={() => void onRemove(status.id)}
            disabled={busy}
          >
            {t('settings.plugins.remove')}
          </Button>
        ) : null}
        <Switch
          checked={on}
          disabled={busy}
          onChange={(next) => void onToggle(status.id, next)}
          label={`${on ? t('settings.plugins.toggle.disable') : t('settings.plugins.toggle.enable')} ${status.name}`}
        />
      </div>
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
