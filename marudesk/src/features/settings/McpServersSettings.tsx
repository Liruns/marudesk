import { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Plus,
  RotateCcw,
  ServerCog,
} from 'lucide-react';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import type { McpConfigHealth, McpServerStatus } from '../../../shared/mcp';
import { MCP_PRESETS } from '../../../shared/mcp-presets';
import { McpServerCard, type McpServerEditablePatch } from './McpServerCard';

/**
 * Settings → MCP Servers (docs/context-mcp-design §8). Lists the user-configured
 * external MCP servers — local (stdio) or remote
 * (HTTP/SSE) — with their transport, connection status, exposed tools, and trust
 * state, plus an enable/disable toggle and a Reload action. Adding/editing a server
 * is done by hand-editing the JSON config (Claude-Desktop style) — the "Open config
 * file" button reveals it. Every tool a connected server exposes is routed through
 * the same loop approval/read-only mediation as the built-in tools (a `trust`ed
 * server skips the per-call approval prompt).
 */
type EmbeddedStatus = { portOpen: boolean; required: boolean };

export function McpServersSettings() {
  const { t } = useI18n();
  const [servers, setServers] = useState<McpServerStatus[] | null>(null);
  const [embedded, setEmbedded] = useState<EmbeddedStatus | null>(null);
  const [configHealth, setConfigHealth] = useState<McpConfigHealth | null>(null);
  const [busy, setBusy] = useState(false);

  // Whether the browser-control preset drives the embedded Chromium, and whether the
  // remote-debugging port it attaches to was opened this launch (boot-only switch).
  const refreshEmbedded = () => {
    void window.marudesk
      .invoke('mcp:embedded-browser-status')
      .then(setEmbedded)
      .catch(() => {});
  };

  const refreshConfigHealth = async () => {
    try {
      setConfigHealth(await window.marudesk.invoke('mcp:config-diagnostics'));
    } catch {
      // A diagnostics read should not make the rest of the panel unusable.
    }
  };

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
    void window.marudesk
      .invoke('mcp:config-diagnostics')
      .then((health) => {
        if (alive) setConfigHealth(health);
      })
      .catch(() => {});
    refreshEmbedded();
    return () => {
      alive = false;
    };
  }, []);

  const reload = async () => {
    setBusy(true);
    try {
      setServers(await window.marudesk.invoke('mcp:reload'));
      await refreshConfigHealth();
      refreshEmbedded();
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
      await refreshConfigHealth();
      refreshEmbedded();
    } catch {
      // no-op — the list stays as-is
    } finally {
      setBusy(false);
    }
  };

  const updateServer = async (id: string, patch: McpServerEditablePatch) => {
    setBusy(true);
    try {
      setServers(await window.marudesk.invoke('mcp:update-server', { id, ...patch }));
      await refreshConfigHealth();
      refreshEmbedded();
    } catch {
      // no-op - the list stays as-is
    } finally {
      setBusy(false);
    }
  };

  const removeServer = async (id: string) => {
    setBusy(true);
    try {
      setServers(await window.marudesk.invoke('mcp:remove-server', { id }));
      await refreshConfigHealth();
      refreshEmbedded();
    } catch {
      // no-op - the list stays as-is
    } finally {
      setBusy(false);
    }
  };

  const addPreset = async (id: string) => {
    setBusy(true);
    try {
      setServers(await window.marudesk.invoke('mcp:add-preset', { id }));
      await refreshConfigHealth();
      refreshEmbedded();
    } catch {
      // no-op — leave the list as-is on a transient failure
    } finally {
      setBusy(false);
    }
  };

  const openConfig = () => {
    void window.marudesk
      .invoke('mcp:open-config')
      .then(() => refreshConfigHealth())
      .catch(() => {});
  };

  const configuredIds = new Set((servers ?? []).map((s) => s.id));

  return (
    <div className="flex flex-col gap-2">
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

      <McpConfigDiagnosticsBanner health={configHealth} />

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

      {embedded?.required ? (
        embedded.portOpen ? (
          <div className="flex items-start gap-2 rounded-lg border border-success/40 bg-success-subtle px-4 py-3 text-body-sm text-fg-secondary">
            <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-success" />
            <span>{t('settings.mcp.embedded.active')}</span>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-subtle px-4 py-3 text-body-sm text-fg-secondary">
            <AlertCircle size={15} className="mt-0.5 shrink-0 text-warning" />
            <span>{t('settings.mcp.embedded.restart')}</span>
          </div>
        )
      ) : null}

      <div className="flex flex-col gap-2">
        {servers === null ? (
          <EmptyRow text={t('settings.mcp.loading')} />
        ) : servers.length === 0 ? (
          <EmptyRow text={t('settings.mcp.empty')} />
        ) : (
          servers.map((s) => (
            <McpServerCard
              key={s.id}
              status={s}
              busy={busy}
              onToggle={toggle}
              onUpdate={updateServer}
              onRemove={removeServer}
            />
          ))
        )}
      </div>
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-subtle bg-surface-1 px-4 py-2 text-body-sm text-fg-tertiary">
      <ServerCog size={15} className="shrink-0" />
      <span>{text}</span>
    </div>
  );
}

function McpConfigDiagnosticsBanner({ health }: { readonly health: McpConfigHealth | null }) {
  const { t } = useI18n();
  if (!health || health.diagnostics.length === 0) return null;
  const hasError = health.diagnostics.some((d) => d.severity === 'error');
  const shown = health.diagnostics.slice(0, 4);
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border px-4 py-3 text-body-sm text-fg-secondary',
        hasError
          ? 'border-error/40 bg-error-subtle/40'
          : 'border-warning/40 bg-warning-subtle/40',
      )}
    >
      <AlertCircle
        size={15}
        className={cn('mt-0.5 shrink-0', hasError ? 'text-error' : 'text-warning')}
      />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-fg-primary">
          {hasError
            ? t('settings.mcp.configDiagnostics.error')
            : t('settings.mcp.configDiagnostics.warning')}
        </div>
        <div className="mt-1 flex flex-col gap-1">
          {shown.map((diagnostic, index) => (
            <span
              key={`${diagnostic.code}-${diagnostic.index ?? 'root'}-${diagnostic.serverId ?? 'config'}-${diagnostic.field ?? 'all'}-${index}`}
              className="break-words"
            >
              {diagnostic.message}
            </span>
          ))}
        </div>
        {health.diagnostics.length > shown.length ? (
          <div className="mt-1 text-caption text-fg-tertiary">
            {t('settings.mcp.configDiagnostics.more').replace(
              '{count}',
              String(health.diagnostics.length - shown.length),
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
