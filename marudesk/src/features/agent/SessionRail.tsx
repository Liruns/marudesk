import { useState } from 'react';
import { History, PanelLeftClose } from 'lucide-react';
import { useI18n } from '../../i18n/useI18n';
import { SessionList } from './SessionList';

/**
 * Full-surface left rail listing saved sessions (v3 §5-C), mirroring the
 * ExplorerPanel `<aside>` structure (h-9 header + scrollable body). Collapsible
 * to a thin strip; v1 has no drag-resize (fixed 240px). Hosted by AgentTab
 * beside the centered chat column — the drawer companion uses an overlay instead.
 */
export function SessionRail() {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <aside className="flex h-full w-8 shrink-0 flex-col items-center border-r border-subtle bg-surface-1 py-2.5 gap-1">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label={t('agent.sessions.showHistory')}
          title={t('agent.sessions.history')}
          className="rounded p-1 text-fg-tertiary/60 transition-colors duration-fast hover:text-fg-primary hover:bg-surface-3"
        >
          <History size={14} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-subtle bg-surface-1">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-subtle pl-3 pr-1.5">
        <span className="flex items-center gap-1.5 text-[0.6875rem] font-semibold uppercase tracking-widest text-fg-tertiary/70 select-none">
          <History size={11} />
          {t('agent.sessions.history')}
        </span>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label={t('agent.sessions.hideHistory')}
          className="rounded p-0.5 text-fg-tertiary/60 transition-colors duration-fast hover:text-fg-primary hover:bg-surface-3"
        >
          <PanelLeftClose size={13} />
        </button>
      </header>
      <SessionList className="flex-1" />
    </aside>
  );
}
