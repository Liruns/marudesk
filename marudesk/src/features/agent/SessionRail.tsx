import { useState } from 'react';
import { History, PanelLeftClose } from 'lucide-react';
import { SessionList } from './SessionList';

/**
 * Full-surface left rail listing saved sessions (v3 §5-C), mirroring the
 * ExplorerPanel `<aside>` structure (h-9 header + scrollable body). Collapsible
 * to a thin strip; v1 has no drag-resize (fixed 240px). Hosted by AgentTab
 * beside the centered chat column — the drawer companion uses an overlay instead.
 */
export function SessionRail() {
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <aside className="flex h-full w-9 shrink-0 flex-col items-center border-r border-subtle bg-surface-1 py-2">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label="Show session history"
          title="Session history"
          className="text-fg-tertiary transition-colors duration-fast hover:text-fg-primary"
        >
          <History size={16} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-subtle bg-surface-1">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-subtle pl-3 pr-1.5">
        <span className="flex items-center gap-1.5 text-caption font-medium uppercase tracking-wider text-fg-tertiary">
          <History size={12} />
          History
        </span>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label="Hide session history"
          className="text-fg-tertiary transition-colors duration-fast hover:text-fg-primary"
        >
          <PanelLeftClose size={14} />
        </button>
      </header>
      <SessionList className="flex-1" />
    </aside>
  );
}
