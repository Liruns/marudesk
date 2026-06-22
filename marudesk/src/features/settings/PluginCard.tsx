import { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  PanelRight,
  ScrollText,
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
  const [logsOpen, setLogsOpen] = useState(false);
  const [logLines, setLogLines] = useState<readonly string[]>([]);

  // Enabling a plugin grants ALL its declared permissions at once (the manager
  // writes granted: declared) — including cmd (shell exec), fs:write, and net. A
  // single Switch flip is otherwise a high-impact grant with no consent step, so
  // confirm first and enumerate exactly what is being granted.
  const SENSITIVE: ReadonlySet<string> = new Set(['cmd', 'fs:write', 'net']);
  const handleToggle = (next: boolean): void => {
    if (next && status.permissions.length > 0) {
      let message = t('settings.plugins.grantConfirm')
        .replace('{name}', status.name)
        .replace('{perms}', status.permissions.join(', '));
      if (status.permissions.some((perm) => SENSITIVE.has(perm))) {
        message += `\n\n${t('settings.plugins.grantConfirmSensitive')}`;
      }
      if (!window.confirm(message)) return;
    }
    void onToggle(status.id, next);
  };

  const toggleLogs = async (): Promise<void> => {
    const next = !logsOpen;
    setLogsOpen(next);
    if (next) {
      const lines = await window.marudesk.invoke('plugins:logs', { id: status.id });
      setLogLines(lines);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-subtle bg-surface-1 px-4 py-2">
      <div className="flex items-center justify-between gap-3">
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
          onChange={handleToggle}
          label={`${on ? t('settings.plugins.toggle.disable') : t('settings.plugins.toggle.enable')} ${status.name}`}
        />
      </div>
      </div>

      {on ? (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => void toggleLogs()}
            aria-expanded={logsOpen}
            className="flex items-center gap-1 self-start text-caption text-fg-tertiary transition-colors hover:text-fg-secondary"
          >
            {logsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <ScrollText size={12} />
            {t('settings.plugins.logs')}
          </button>
          {logsOpen ? (
            logLines.length > 0 ? (
              <pre className="max-h-40 overflow-auto rounded-md bg-surface-3 px-2 py-1.5 text-caption font-mono whitespace-pre-wrap break-words text-fg-secondary">
                {logLines.join('\n')}
              </pre>
            ) : (
              <span className="text-caption text-fg-tertiary">{t('settings.plugins.logs.empty')}</span>
            )
          ) : null}
        </div>
      ) : null}
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
