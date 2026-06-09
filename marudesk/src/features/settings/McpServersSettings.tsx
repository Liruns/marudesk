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
import type { McpServerStatus } from '../../../shared/mcp';
import { MCP_PRESETS } from '../../../shared/mcp-presets';
import { McpServerCard, type McpServerEditablePatch } from './McpServerCard';

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
type EmbeddedStatus = { portOpen: boolean; required: boolean };

export function McpServersSettings() {
  const { t } = useI18n();
  const [servers, setServers] = useState<McpServerStatus[] | null>(null);
  const [embedded, setEmbedded] = useState<EmbeddedStatus | null>(null);
  const [busy, setBusy] = useState(false);

  // Whether the browser-control preset drives the embedded Chromium, and whether the
  // remote-debugging port it attaches to was opened this launch (boot-only switch).
  const refreshEmbedded = () => {
    void window.marudesk
      .invoke('mcp:embedded-browser-status')
      .then(setEmbedded)
      .catch(() => {});
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
    refreshEmbedded();
    return () => {
      alive = false;
    };
  }, []);

  const reload = async () => {
    setBusy(true);
    try {
      setServers(await window.marudesk.invoke('mcp:reload'));
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
      refreshEmbedded();
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
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-subtle bg-surface-1 px-4 py-3 text-body-sm text-fg-tertiary">
      <ServerCog size={15} className="shrink-0" />
      <span>{text}</span>
    </div>
  );
}
