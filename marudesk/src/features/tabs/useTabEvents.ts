import { useEffect } from 'react';
import { useWebPageStore } from '../browser/store';
import { useDownloadsStore } from '../browser/downloads';
import { useWorkspaceDeckStore } from '../workspaces/store';
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
    const offWorkspaces = window.marudesk.on('workspaces:state', (snap) => {
      useWorkspaceDeckStore.getState().ingestSnapshot(snap);
    });
    // Ctrl/Cmd+L while a web page had focus: main asks us to focus the bar.
    const offFocusBar = window.marudesk.on('browser:focus-address-bar', () => {
      useWebPageStore.getState().focusAddressBar();
    });
    // Ctrl/Cmd+F while a web page had focus: main asks us to open the find bar.
    const offOpenFind = window.marudesk.on('browser:open-find', () => {
      useWebPageStore.getState().openFind();
    });
    // Async find match counts for the active tab's find bar.
    const offFound = window.marudesk.on('browser:found-in-page', (r) => {
      useWebPageStore.getState().setFindResult(r.matches, r.activeMatchOrdinal);
    });
    // Live download list for the shelf.
    const offDownloads = window.marudesk.on('browser:downloads', (list) => {
      useDownloadsStore.getState().setDownloads(list);
    });
    // Pull the current snapshot once on mount so the tab strip renders
    // immediately even before the first nav event fires.
    void useTabsStore.getState().refreshTabsSnapshot().catch(() => undefined);
    void window.marudesk
      .invoke('browser:downloads-list')
      .then((list) => useDownloadsStore.getState().setDownloads(list))
      .catch(() => undefined);
    return () => {
      offCapture();
      offExit();
      offNav();
      offTabs();
      offWorkspaces();
      offFocusBar();
      offOpenFind();
      offFound();
      offDownloads();
    };
  }, []);
}
