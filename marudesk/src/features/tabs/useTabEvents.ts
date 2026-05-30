import { useEffect } from 'react';
import { useWebPageStore } from '../browser/store';
import { useTabsStore } from './store';

/**
 * Bridge the main-process browser events into the renderer stores. Tab/nav
 * events feed the tab registry store; capture/inspect events feed the web-page
 * store — this hook is the one place that legitimately touches both, since it
 * sits above them rather than inside either. Mount once (in the shell).
 */
export function useTabEvents(): void {
  useEffect(() => {
    const offCapture = window.marudesk.on('browser:capture', (capture) => {
      useWebPageStore.getState().addCapture(capture);
    });
    const offExit = window.marudesk.on('browser:inspect-exit', () => {
      useWebPageStore.setState({ inspectMode: false });
    });
    const offNav = window.marudesk.on('browser:nav-state', (state) => {
      useTabsStore.getState().setNavState(state);
    });
    const offTabs = window.marudesk.on('browser:tabs-state', (snap) => {
      useTabsStore.getState().setTabsState(snap);
    });
    // Pull the current snapshot once on mount so the tab strip renders
    // immediately even before the first nav event fires.
    void useTabsStore.getState().refreshTabsSnapshot().catch(() => undefined);
    return () => {
      offCapture();
      offExit();
      offNav();
      offTabs();
    };
  }, []);
}
