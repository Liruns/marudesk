import { useState, type ReactNode } from 'react';
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
  const disabledTools = textToList(disabledText);
  const autoApproveTools = textToList(autoApproveText);
  const confirmTools = textToList(confirmText);
  const disabledSet = new Set(disabledTools);
  const autoApproveSet = new Set(autoApproveTools);
  const confirmSet = new Set(confirmTools);
  const exposedTools = status.tools ?? [];
  const policyTools = uniqueList([...disabledTools, ...autoApproveTools, ...confirmTools]);
  const knownTools = uniqueList([...exposedTools, ...policyTools]);
  const savedKnownTools = new Set(uniqueList([
    ...exposedTools,
    ...status.disabledTools,
    ...status.autoApproveTools,
    ...status.confirmTools,
  ]));
  const hasDiscoveredTools = status.state === 'connected' && knownTools.length > 0;
  const unknownManualTools = hasDiscoveredTools
    ? policyTools.filter((tool) => !savedKnownTools.has(tool))
    : [];
  const conflictingTools = uniqueList([
    ...disabledTools.filter((tool) => autoApproveSet.has(tool) || confirmSet.has(tool)),
    ...autoApproveTools.filter((tool) => confirmSet.has(tool)),
  ]);

  // Reset the local drafts whenever the SAVED values change (a save round-trip,
  // an external update, or switching to another server's card). Done during
  // render with the previous-values pattern (react.dev "adjusting state when a
  // prop changes") instead of an effect, so the reset doesn't cost an extra
  // committed render pass.
  const [prevSync, setPrevSync] = useState({
    id: status.id,
    trusted: status.trusted,
    disabled: statusDisabled,
    autoApprove: statusAutoApprove,
    confirm: statusConfirm,
  });
  if (
    prevSync.id !== status.id ||
    prevSync.trusted !== status.trusted ||
    prevSync.disabled !== statusDisabled ||
    prevSync.autoApprove !== statusAutoApprove ||
    prevSync.confirm !== statusConfirm
  ) {
    setPrevSync({
      id: status.id,
      trusted: status.trusted,
      disabled: statusDisabled,
      autoApprove: statusAutoApprove,
      confirm: statusConfirm,
    });
    setTrusted(status.trusted);
    setDisabledText(statusDisabled);
    setAutoApproveText(statusAutoApprove);
    setConfirmText(statusConfirm);
  }

  const dirty =
    trusted !== status.trusted ||
    disabledText !== statusDisabled ||
    autoApproveText !== statusAutoApprove ||
    confirmText !== statusConfirm;

  const save = async () => {
    await onUpdate(status.id, {
      trust: trusted,
      disabledTools,
      autoApproveTools,
      confirmTools,
    });
  };

  const updateToolPolicy = (
    tool: string,
    mode: 'disabled' | 'autoApprove' | 'confirm',
  ) => {
    let nextDisabled = disabledTools;
    let nextAutoApprove = autoApproveTools;
    let nextConfirm = confirmTools;
    if (mode === 'disabled') {
      const enabled = !disabledSet.has(tool);
      nextDisabled = toggleList(nextDisabled, tool, enabled);
      if (enabled) {
        nextAutoApprove = toggleList(nextAutoApprove, tool, false);
        nextConfirm = toggleList(nextConfirm, tool, false);
      }
    } else if (mode === 'autoApprove') {
      const enabled = !autoApproveSet.has(tool);
      nextAutoApprove = toggleList(nextAutoApprove, tool, enabled);
      if (enabled) {
        nextDisabled = toggleList(nextDisabled, tool, false);
        nextConfirm = toggleList(nextConfirm, tool, false);
      }
    } else {
      const enabled = !confirmSet.has(tool);
      nextConfirm = toggleList(nextConfirm, tool, enabled);
      if (enabled) {
        nextDisabled = toggleList(nextDisabled, tool, false);
        nextAutoApprove = toggleList(nextAutoApprove, tool, false);
      }
    }
    setDisabledText(listToText(nextDisabled));
    setAutoApproveText(listToText(nextAutoApprove));
    setConfirmText(listToText(nextConfirm));
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

      {hasDiscoveredTools ? (
        <div className="flex flex-col gap-2">
          <div className="text-caption uppercase tracking-wider text-fg-tertiary">
            {t('settings.mcp.tools.discovered')}
          </div>
          <div className="flex max-h-56 flex-col overflow-y-auto rounded-md border border-subtle bg-surface-page">
            {knownTools.map((tool) => (
              <ToolPolicyRow
                key={tool}
                tool={tool}
                busy={busy}
                disabledSelected={disabledSet.has(tool)}
                autoApproveSelected={autoApproveSet.has(tool)}
                confirmSelected={confirmSet.has(tool)}
                onChange={updateToolPolicy}
              />
            ))}
          </div>
        </div>
      ) : null}

      {unknownManualTools.length > 0 ? (
        <ToolPolicyWarning
          text={t('settings.mcp.tools.unknownNames').replace('{tools}', unknownManualTools.join(', '))}
        />
      ) : null}
      {conflictingTools.length > 0 ? (
        <ToolPolicyWarning
          text={t('settings.mcp.tools.conflicts').replace('{tools}', conflictingTools.join(', '))}
        />
      ) : null}

      {hasDiscoveredTools ? (
        <details className="rounded-md border border-subtle bg-surface-page/60 px-3 py-2">
          <summary className="cursor-pointer text-caption uppercase tracking-wider text-fg-tertiary">
            {t('settings.mcp.tools.advanced')}
          </summary>
          <ToolListGrid
            busy={busy}
            disabledText={disabledText}
            autoApproveText={autoApproveText}
            confirmText={confirmText}
            onDisabledChange={setDisabledText}
            onAutoApproveChange={setAutoApproveText}
            onConfirmChange={setConfirmText}
          />
        </details>
      ) : (
        <ToolListGrid
          busy={busy}
          disabledText={disabledText}
          autoApproveText={autoApproveText}
          confirmText={confirmText}
          onDisabledChange={setDisabledText}
          onAutoApproveChange={setAutoApproveText}
          onConfirmChange={setConfirmText}
        />
      )}

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

function ToolPolicyRow({
  tool,
  busy,
  disabledSelected,
  autoApproveSelected,
  confirmSelected,
  onChange,
}: {
  readonly tool: string;
  readonly busy: boolean;
  readonly disabledSelected: boolean;
  readonly autoApproveSelected: boolean;
  readonly confirmSelected: boolean;
  readonly onChange: (tool: string, mode: 'disabled' | 'autoApprove' | 'confirm') => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-10 items-center gap-2 border-b border-subtle px-2 py-1 last:border-b-0">
      <span className="min-w-0 flex-1 truncate font-mono text-caption text-fg-secondary" title={tool}>
        {tool}
      </span>
      <IconToggleButton
        selected={disabledSelected}
        disabled={busy}
        title={`${t('settings.mcp.tools.disabled')}: ${tool}`}
        onClick={() => onChange(tool, 'disabled')}
      >
        <CircleSlash size={13} />
      </IconToggleButton>
      <IconToggleButton
        selected={autoApproveSelected}
        disabled={busy}
        title={`${t('settings.mcp.tools.autoApprove')}: ${tool}`}
        onClick={() => onChange(tool, 'autoApprove')}
      >
        <CheckCircle2 size={13} />
      </IconToggleButton>
      <IconToggleButton
        selected={confirmSelected}
        disabled={busy}
        title={`${t('settings.mcp.tools.confirm')}: ${tool}`}
        onClick={() => onChange(tool, 'confirm')}
      >
        <AlertCircle size={13} />
      </IconToggleButton>
    </div>
  );
}

function IconToggleButton({
  selected,
  disabled,
  title,
  onClick,
  children,
}: {
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly title: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex size-7 shrink-0 items-center justify-center rounded border transition-colors duration-fast',
        selected
          ? 'border-accent bg-accent text-white'
          : 'border-subtle bg-surface-1 text-fg-tertiary hover:text-fg-primary',
        'disabled:cursor-not-allowed disabled:opacity-50',
      )}
    >
      {children}
    </button>
  );
}

function ToolPolicyWarning({ text }: { readonly text: string }) {
  return (
    <div className="flex items-start gap-2 rounded border border-warning/40 bg-warning-subtle/30 px-3 py-2 text-caption text-fg-secondary">
      <AlertCircle size={13} className="mt-0.5 shrink-0 text-warning" />
      <span className="min-w-0 break-words">{text}</span>
    </div>
  );
}

function ToolListGrid({
  busy,
  disabledText,
  autoApproveText,
  confirmText,
  onDisabledChange,
  onAutoApproveChange,
  onConfirmChange,
}: {
  readonly busy: boolean;
  readonly disabledText: string;
  readonly autoApproveText: string;
  readonly confirmText: string;
  readonly onDisabledChange: (value: string) => void;
  readonly onAutoApproveChange: (value: string) => void;
  readonly onConfirmChange: (value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="mt-2 grid gap-2 md:grid-cols-3">
      <ToolListField
        label={t('settings.mcp.tools.disabled')}
        value={disabledText}
        disabled={busy}
        onChange={onDisabledChange}
      />
      <ToolListField
        label={t('settings.mcp.tools.autoApprove')}
        value={autoApproveText}
        disabled={busy}
        onChange={onAutoApproveChange}
      />
      <ToolListField
        label={t('settings.mcp.tools.confirm')}
        value={confirmText}
        disabled={busy}
        onChange={onConfirmChange}
      />
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
  return uniqueList(value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean));
}

function uniqueList(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function toggleList(values: readonly string[], item: string, enabled: boolean): string[] {
  const existing = uniqueList(values);
  if (!enabled) return existing.filter((value) => value !== item);
  return existing.includes(item) ? existing : [...existing, item];
}
