import { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  CircleSlash,
  Globe,
  Loader2,
  Save,
  ShieldCheck,
  TerminalSquare,
  Trash2,
} from 'lucide-react';
import { Badge, Button, Switch } from '../../components/ui';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import type { McpServerStatus } from '../../../shared/mcp';

export type McpServerEditablePatch = {
  readonly trust?: boolean;
  readonly disabledTools?: string[];
  readonly autoApproveTools?: string[];
  readonly confirmTools?: string[];
};

export function McpServerCard({
  status,
  busy,
  onToggle,
  onUpdate,
  onRemove,
}: {
  readonly status: McpServerStatus;
  readonly busy: boolean;
  readonly onToggle: (id: string, enabled: boolean) => Promise<void>;
  readonly onUpdate: (id: string, patch: McpServerEditablePatch) => Promise<void>;
  readonly onRemove: (id: string) => Promise<void>;
}) {
  const TransportIcon = status.transport === 'stdio' ? TerminalSquare : Globe;
  const { t } = useI18n();
  const statusDisabled = listToText(status.disabledTools);
  const statusAutoApprove = listToText(status.autoApproveTools);
  const statusConfirm = listToText(status.confirmTools);
  const [trusted, setTrusted] = useState(status.trusted);
  const [disabledText, setDisabledText] = useState(statusDisabled);
  const [autoApproveText, setAutoApproveText] = useState(statusAutoApprove);
  const [confirmText, setConfirmText] = useState(statusConfirm);

  useEffect(() => {
    setTrusted(status.trusted);
    setDisabledText(statusDisabled);
    setAutoApproveText(statusAutoApprove);
    setConfirmText(statusConfirm);
  }, [status.id, status.trusted, statusDisabled, statusAutoApprove, statusConfirm]);

  const dirty =
    trusted !== status.trusted ||
    disabledText !== statusDisabled ||
    autoApproveText !== statusAutoApprove ||
    confirmText !== statusConfirm;

  const save = async () => {
    await onUpdate(status.id, {
      trust: trusted,
      disabledTools: textToList(disabledText),
      autoApproveTools: textToList(autoApproveText),
      confirmTools: textToList(confirmText),
    });
  };

  const remove = async () => {
    if (!window.confirm(t('settings.mcp.removeConfirm'))) return;
    await onRemove(status.id);
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-subtle bg-surface-1 px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-body-sm font-medium text-fg-primary">{status.id}</span>
            <StatusBadge status={status} />
            {status.trusted ? (
              <Badge variant="accent" className="gap-1">
                <ShieldCheck size={11} />
                {t('settings.mcp.trust.badge')}
              </Badge>
            ) : null}
            <span className="shrink-0 text-caption uppercase tracking-wide text-fg-tertiary/70">
              {status.transport === 'http'
                ? t('settings.mcp.transport.remote')
                : t('settings.mcp.transport.stdio')}
            </span>
          </div>
          <span className="flex min-w-0 items-center gap-1.5 truncate font-mono text-caption text-fg-tertiary">
            <TransportIcon size={12} className="shrink-0" />
            {status.target}
          </span>
          {status.state === 'connected' && status.tools && status.tools.length > 0 ? (
            <span className="truncate text-caption text-fg-tertiary" title={status.tools.join(', ')}>
              {status.tools.join(', ')}
            </span>
          ) : null}
          {status.state === 'error' && status.error ? (
            <span className="truncate text-caption text-error">{status.error}</span>
          ) : null}
        </div>
        <Switch
          checked={status.enabled}
          disabled={busy}
          onChange={(next) => void onToggle(status.id, next)}
          label={`${status.enabled ? t('settings.mcp.toggle.disable') : t('settings.mcp.toggle.enable')} ${status.id}`}
        />
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-subtle pt-2">
        <div className="min-w-0">
          <div className="text-body-sm font-medium text-fg-primary">{t('settings.mcp.trust.label')}</div>
          <div className="text-caption text-fg-tertiary">{t('settings.mcp.trust.description')}</div>
        </div>
        <Switch
          checked={trusted}
          disabled={busy}
          onChange={setTrusted}
          label={`${t('settings.mcp.trust.label')} ${status.id}`}
        />
      </div>

      <div className="grid gap-2 md:grid-cols-3">
        <ToolListField
          label={t('settings.mcp.tools.disabled')}
          value={disabledText}
          disabled={busy}
          onChange={setDisabledText}
        />
        <ToolListField
          label={t('settings.mcp.tools.autoApprove')}
          value={autoApproveText}
          disabled={busy}
          onChange={setAutoApproveText}
        />
        <ToolListField
          label={t('settings.mcp.tools.confirm')}
          value={confirmText}
          disabled={busy}
          onChange={setConfirmText}
        />
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<Trash2 size={14} />}
          disabled={busy}
          onClick={() => void remove()}
        >
          {t('settings.mcp.remove')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          leadingIcon={<Save size={14} />}
          disabled={busy || !dirty}
          onClick={() => void save()}
        >
          {t('settings.mcp.save')}
        </Button>
      </div>
    </div>
  );
}

function ToolListField({
  label,
  value,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-caption uppercase tracking-wider text-fg-tertiary">{label}</span>
      <textarea
        value={value}
        rows={3}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        placeholder={t('settings.mcp.tools.placeholder')}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          'min-h-20 w-full resize-y rounded-md border border-default bg-surface-page px-3 py-2',
          'font-mono text-body-sm text-fg-primary placeholder:text-fg-tertiary',
          'focus:outline-none focus:border-accent transition-colors duration-fast',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      />
    </label>
  );
}

function StatusBadge({ status }: { readonly status: McpServerStatus }) {
  const { formatMcpToolCount, t } = useI18n();
  if (status.state === 'connected') {
    return (
      <Badge variant="success" className="gap-1">
        <CheckCircle2 size={11} />
        {formatMcpToolCount(status.toolCount)}
      </Badge>
    );
  }
  if (status.state === 'connecting' || status.state === 'reconnecting') {
    return (
      <Badge variant="accent" className="gap-1">
        <Loader2 size={11} className="animate-spin" />
        {status.state === 'reconnecting'
          ? t('settings.mcp.status.reconnecting')
          : t('settings.mcp.status.connecting')}
      </Badge>
    );
  }
  if (status.state === 'error') {
    return (
      <Badge variant="error" className="gap-1">
        <AlertCircle size={11} />
        {t('settings.mcp.status.error')}
      </Badge>
    );
  }
  return (
    <Badge variant="neutral" className="gap-1">
      <CircleSlash size={11} />
      {t('settings.mcp.status.disabled')}
    </Badge>
  );
}

function listToText(values: readonly string[]): string {
  return values.join('\n');
}

function textToList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
