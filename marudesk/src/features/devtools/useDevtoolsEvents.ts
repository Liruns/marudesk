import { useEffect } from 'react';
import { useTabsStore } from '../tabs/store';
import { useDevtoolsStore } from './store';

/**
 * Bridge the main-process DevTools events into the session store, and keep the
 * dock bound to the active web tab. Mount once (in the Shell), like
 * useTabEvents.
 *
 * - `devtools:cdp-event`  → ingest (filtered to the bound tab; stale in-flight
 *   events from a just-rebound tab are dropped).
 * - `devtools:detached`   → reset the session machine.
 * - `devtools:toggle`     → in-page F12 (page had focus) — same as the wrench.
 * - `devtools:inspect-at` → context-menu "Inspect Element".
 * - active-tab change     → rebind the session to the new web tab.
 */
export function useDevtoolsEvents(): void {
  useEffect(() => {
    const offEvent = window.marudesk.on('devtools:cdp-event', (payload) => {
      if (payload.tabId !== useDevtoolsStore.getState().tabId) return;
      useDevtoolsStore.getState().ingestBatch(payload.items, payload.dropped);
    });
    const offDetached = window.marudesk.on('devtools:detached', (payload) => {
      useDevtoolsStore.getState().handleDetached(payload.tabId, payload.reason);
    });
    const offToggle = window.marudesk.on('devtools:toggle', () => {
      useDevtoolsStore.getState().toggle();
    });
    const offInspect = window.marudesk.on('devtools:inspect-at', (payload) => {
      void useDevtoolsStore
        .getState()
        .inspectAt(payload.tabId, payload.x, payload.y);
    });
    // Always-on console-error counts → the toggle badge. Tracked for ALL tabs
    // (not filtered to the bound one) so switching tabs shows the right count.
    const offErrorCount = window.marudesk.on('devtools:error-count', (payload) => {
      useDevtoolsStore.getState().setErrorCount(payload.tabId, payload.count);
    });

    // Rebind the dock when the active tab changes. The dock follows the active
    // web tab; a feature tab unmounts it (so we pass null → keep the session).
    let lastActive = useTabsStore.getState().activeTabId;
    const offTabs = useTabsStore.subscribe((state) => {
      if (state.activeTabId === lastActive) return;
      lastActive = state.activeTabId;
      const active = state.tabs.find((t) => t.id === state.activeTabId);
      useDevtoolsStore
        .getState()
        .rebindToActive(active?.kind === 'web' ? active.id : null);
    });

    // Reconcile drift on mount: under Vite HMR the store can survive with an
    // open session bound to a stale tab. rebindToActive no-ops when closed or
    // already bound, so this is a cheap safety net (§11.9).
    {
      const st = useTabsStore.getState();
      const active = st.tabs.find((t) => t.id === st.activeTabId);
      useDevtoolsStore
        .getState()
        .rebindToActive(active?.kind === 'web' ? active.id : null);
    }

    return () => {
      offEvent();
      offDetached();
      offToggle();
      offInspect();
      offErrorCount();
      offTabs();
    };
  }, []);
}
