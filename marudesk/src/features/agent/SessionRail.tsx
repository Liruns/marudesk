import { useState } from 'react';
import { History, PanelLeftClose } from 'lucide-react';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { SessionList } from './SessionList';

/**
 * Full-surface left rail listing saved sessions (v3 §5-C), mirroring the
 * ExplorerPanel `<aside>` structure (h-9 header + scrollable body). Collapsible
 * to a thin strip; v1 has no drag-resize (fixed 224px). Hosted by AgentTab
 * beside the centered chat column — the drawer companion uses an overlay instead.
 */
export function SessionRail() {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      aria-label={t('agent.sessions.history')}
      aria-expanded={!collapsed}
      className={cn(
        'relative flex h-full shrink-0 overflow-hidden border-r border-subtle bg-surface-1',
        'transition-[width] duration-standard',
        // Container-query: in a narrow pane (split view) the rail stays a thin
        // strip even when "expanded" — the chat column is the priority there.
        collapsed ? 'w-8' : 'w-8 @[56rem]:w-56',
      )}
    >
      <div className="relative h-full w-56 shrink-0">
        <div
          aria-hidden={!collapsed}
          className={cn(
            'absolute inset-y-0 left-0 flex w-8 flex-col items-center gap-1 py-2.5',
            'transition-opacity duration-fast',
            collapsed
              ? 'opacity-100'
              : 'opacity-100 @[56rem]:pointer-events-none @[56rem]:opacity-0',
          )}
        >
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            aria-label={t('agent.sessions.showHistory')}
            title={t('agent.sessions.history')}
            tabIndex={collapsed ? 0 : -1}
            className="rounded p-1 text-fg-tertiary/60 transition-colors duration-fast hover:text-fg-primary hover:bg-surface-3"
          >
            <History size={14} />
          </button>
        </div>

        <div
          aria-hidden={collapsed}
          className={cn(
            'absolute inset-0 flex flex-col',
            'transition-opacity duration-fast',
            collapsed
              ? 'pointer-events-none opacity-0'
              : 'pointer-events-none opacity-0 @[56rem]:pointer-events-auto @[56rem]:opacity-100',
          )}
        >
          <header className="flex h-9 shrink-0 items-center justify-between border-b border-subtle pl-3 pr-1.5">
            <span className="flex items-center gap-1.5 text-[0.6875rem] font-semibold uppercase tracking-widest text-fg-quaternary select-none">
              <History size={11} />
              {t('agent.sessions.history')}
            </span>
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              aria-label={t('agent.sessions.hideHistory')}
              tabIndex={collapsed ? -1 : 0}
              className="rounded p-0.5 text-fg-tertiary/60 transition-colors duration-fast hover:text-fg-primary hover:bg-surface-3"
            >
              <PanelLeftClose size={13} />
            </button>
          </header>
          <SessionList className="flex-1" />
        </div>
      </div>
    </aside>
  );
}
