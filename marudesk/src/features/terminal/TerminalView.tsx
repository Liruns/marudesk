import { useEffect, useRef } from 'react';
import { useTabsStore } from '../tabs/store';
import { acquireTerminalSession, fitTerminalSession } from './session';

/**
 * The 'terminal' tab surface. The heavy lifting lives in the session registry
 * (session.ts): this component just hosts the active terminal tab's persistent
 * xterm container, re-parenting it in on mount and detaching it on unmount so
 * the shell survives tab switches. The PTY is disposed only when the tab closes.
 */
export function TerminalView({ tabId: pinnedTabId }: { tabId?: string } = {}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // In the single view the active tab IS the terminal being shown; in a grid
  // pane the tab is pinned, so a passed `tabId` wins (each pane owns its
  // session). The session registry keys by this id, so distinct panes get
  // distinct shells.
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const tabId = pinnedTabId ?? activeTabId;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !tabId) return;

    const session = acquireTerminalSession(tabId);
    host.appendChild(session.container);
    // Fit once layout has the host sized, then on every host resize.
    const raf = requestAnimationFrame(() => fitTerminalSession(tabId));
    const ro = new ResizeObserver(() => fitTerminalSession(tabId));
    ro.observe(host);
    session.term.focus();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      // Detach but keep the session alive for re-mount; disposal is the tab's
      // job (see the prune subscription in session.ts).
      if (session.container.parentElement === host) {
        host.removeChild(session.container);
      }
    };
  }, [tabId]);

  return (
    <div
      ref={hostRef}
      className="flex-1 min-h-0 min-w-0 bg-surface-page overflow-hidden p-1.5"
    />
  );
}
