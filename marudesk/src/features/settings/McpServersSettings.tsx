import { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  CircleSlash,
  ExternalLink,
  Globe,
  Loader2,
  Plus,
  RotateCcw,
  ServerCog,
  ShieldCheck,
  TerminalSquare,
} from 'lucide-react';
import { Badge, Button } from '../../components/ui';
import { cn } from '../../lib/cn';
import { useI18n } from '../../i18n/useI18n';
import type { McpServerStatus } from '../../../shared/mcp';
import { MCP_PRESETS } from '../../../shared/mcp-presets';

/**
 * Settings → MCP Servers (docs/remote-mobile-bridge-design §M3, docs/context-mcp-design
 * §8). Lists the user-configured external MCP servers — local (stdio) or remote
 * (HTTP/SSE) — with their transport, connection status, exposed tools, and trust
 * state, plus an enable/disable toggle and a Reload action. Adding/editing a server
 * is done by hand-editing the JSON config (Claude-Desktop style) — the "Open config
 * file" button reveals it. Every tool a connected server exposes is routed through
 * the same loop approval/read-only mediation as the built-in tools (a `trust`ed
 * server skips the per-call approval prompt).
 */
export function McpServersSettings() {
  const { t } = useI18n();
  const [servers, setServers] = useState<McpServerStatus[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.marudesk
      .invoke('mcp:list-servers')
      .then((list) => {
        if (alive) setServers(list);
      })
      .catch(() => {
        if (alive) setServers([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const reload = async () => {
    setBusy(true);
    try {
      setServers(await window.marudesk.invoke('mcp:reload'));
    } catch {
      // Keep the current list; a transient failure shouldn't blank the panel.
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (id: string, enabled: boolean) => {
    setBusy(true);
    try {
      setServers(await window.marudesk.invoke('mcp:set-enabled', { id, enabled }));
    } catch {
      // no-op — the list stays as-is
    } finally {
      setBusy(false);
    }
  };

  const addPreset = async (id: string) => {
    setBusy(true);
    try {
      setServers(await window.marudesk.invoke('mcp:add-preset', { id }));
    } catch {
      // no-op — leave the list as-is on a transient failure
    } finally {
      setBusy(false);
    }
  };

  const openConfig = () => {
    void window.marudesk.invoke('mcp:open-config').catch(() => {});
  };

  const configuredIds = new Set((servers ?? []).map((s) => s.id));

  return (
    <div className="flex flex-col gap-3">
      <p className="text-caption text-fg-tertiary">
        {t('settings.mcp.description')}
      </p>

      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          leadingIcon={busy ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
          onClick={() => void reload()}
          disabled={busy}
        >
          {t('settings.mcp.reload')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<ExternalLink size={14} />}
          onClick={openConfig}
        >
          {t('settings.mcp.openConfig')}
        </Button>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-caption text-fg-tertiary">{t('settings.mcp.presets.label')}</span>
        <div className="flex flex-wrap items-center gap-2">
          {MCP_PRESETS.map((preset) => {
            const added = configuredIds.has(preset.id);
            return (
              <Button
                key={preset.id}
                variant="secondary"
                size="sm"
                leadingIcon={added ? <CheckCircle2 size={14} /> : <Plus size={14} />}
                onClick={() => void addPreset(preset.id)}
                disabled={busy || added}
                title={added ? t('settings.mcp.presets.added') : preset.description}
              >
                {preset.label}
              </Button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {servers === null ? (
          <EmptyRow text={t('settings.mcp.loading')} />
        ) : servers.length === 0 ? (
          <EmptyRow text={t('settings.mcp.empty')} />
        ) : (
          servers.map((s) => (
            <ServerCard key={s.id} status={s} busy={busy} onToggle={toggle} />
          ))
        )}
      </div>
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-subtle bg-surface-1 px-4 py-3 text-body-sm text-fg-tertiary">
      <ServerCog size={15} className="shrink-0" />
      <span>{text}</span>
    </div>
  );
}

function ServerCard({
  status,
  busy,
  onToggle,
}: {
  status: McpServerStatus;
  busy: boolean;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
}) {
  const TransportIcon = status.transport === 'stdio' ? TerminalSquare : Globe;
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-subtle bg-surface-1 px-4 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-body-sm font-medium text-fg-primary truncate">{status.id}</span>
          <StatusBadge status={status} />
          {status.trusted ? (
            <Badge variant="accent" className="gap-1">
              <ShieldCheck size={11} />
              Trusted
            </Badge>
          ) : null}
          <span className="text-caption uppercase tracking-wide text-fg-tertiary/70 shrink-0">
            {status.transport === 'http'
              ? t('settings.mcp.transport.remote')
              : t('settings.mcp.transport.stdio')}
          </span>
        </div>
        <span className="flex items-center gap-1.5 text-caption font-mono text-fg-tertiary truncate">
          <TransportIcon size={12} className="shrink-0" />
          {status.target}
        </span>
        {status.state === 'connected' && status.tools && status.tools.length > 0 ? (
          <span className="text-caption text-fg-tertiary truncate" title={status.tools.join(', ')}>
            {status.tools.join(', ')}
          </span>
        ) : null}
        {status.state === 'error' && status.error ? (
          <span className="text-caption text-error truncate">{status.error}</span>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={status.enabled}
        aria-label={`${status.enabled ? t('settings.mcp.toggle.disable') : t('settings.mcp.toggle.enable')} ${status.id}`}
        disabled={busy}
        onClick={() => void onToggle(status.id, !status.enabled)}
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-pill transition-colors duration-fast',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          status.enabled ? 'bg-accent' : 'bg-surface-3',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 size-4 rounded-full bg-white transition-transform duration-fast',
            status.enabled ? 'translate-x-[18px]' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  );
}

function StatusBadge({ status }: { status: McpServerStatus }) {
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
