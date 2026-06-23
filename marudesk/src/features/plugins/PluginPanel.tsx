import { useEffect, useRef, useState } from 'react';
import { Blocks } from 'lucide-react';
import { PLUGIN_SCHEME } from '../../../shared/plugin';
import type { TabState } from '../../../shared/browser';
import { useTabsStore } from '../tabs/store';
import { useAgentStore } from '../agent/store';
import { useI18n } from '../../i18n/useI18n';

/**
 * A plugin's sandboxed UI panel (docs/plugin-runtime-design.md §8.5). Renders the
 * plugin's `panel://` HTML inside an `<iframe sandbox="allow-scripts">` — no
 * `allow-same-origin`, so the frame is an opaque origin that can't touch the host
 * DOM, cookies, `window.marudesk`, or the network (the `plugin://` response also
 * sets `connect-src 'none'`). The only channel is a narrow, validated postMessage
 * bridge: the panel may ask to insert a prompt into the composer or report its
 * height. It can NOT run tools (that would bypass the agent's approval mediation);
 * panels drive work through prompts, like a user typing.
 */
export function PluginPanel({ tabId }: { tabId?: string }) {
  const { t } = useI18n();
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const id = tabId ?? activeTabId ?? '';
  const tab = useTabsStore((s) => s.tabs.find((candidate: TabState) => candidate.id === id));
  const panel = tab?.pluginPanel;
  const setDraft = useAgentStore((s) => s.setDraft);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const frame = iframeRef.current;
    if (!frame || !panel) return;
    const onMessage = (event: MessageEvent) => {
      // Only trust messages from THIS panel's frame (opaque origin ⇒ origin is
      // 'null', so we gate on the source window, not the origin string).
      if (event.source !== frame.contentWindow) return;
      const data = event.data as { type?: unknown; text?: unknown; height?: unknown };
      if (!data || typeof data.type !== 'string') return;
      if (data.type === 'plugin:insertPrompt' && typeof data.text === 'string') {
        setDraft(data.text.slice(0, 8000));
      } else if (data.type === 'plugin:resize' && typeof data.height === 'number') {
        // Clamp so a panel can't claim an absurd height.
        setHeight(Math.max(80, Math.min(4000, Math.round(data.height))));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [panel, setDraft]);

  if (!panel) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-body-sm text-fg-tertiary">
        <Blocks size={16} />
        <span>{t('plugin.panel.unavailable')}</span>
      </div>
    );
  }

  const src = `${PLUGIN_SCHEME}://${panel.id}/${panel.entry}`;
  return (
    <div className="h-full w-full overflow-auto bg-surface-0">
      <iframe
        ref={iframeRef}
        title={`${panel.id} panel`}
        src={src}
        // No allow-same-origin: the frame is an opaque origin, fully isolated from
        // the host. allow-scripts lets the plugin's own JS run inside that sandbox.
        sandbox="allow-scripts"
        className="w-full border-0"
        style={{ height: height ? `${height}px` : '100%', minHeight: '100%' }}
      />
    </div>
  );
}
