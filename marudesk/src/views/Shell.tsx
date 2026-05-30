import { useEffect, useState } from 'react';
import { ActivityBar } from '../components/ActivityBar';
import { StatusBar } from '../components/StatusBar';
import { TitleBar } from '../components/TitleBar';
import { Stage } from '../features/tabs/Stage';
import { useTabsStore } from '../features/tabs/store';
import { useWebPageStore } from '../features/browser/store';
import { useTabEvents } from '../features/tabs/useTabEvents';
import { useDevtoolsStore } from '../features/devtools/store';
import { useDevtoolsEvents } from '../features/devtools/useDevtoolsEvents';
import { ExplorerPanel } from '../features/workspace/ExplorerPanel';
import { confirmCloseTab } from '../features/editor/store';
import { ContextDrawer } from '../features/context/ContextDrawer';
import { ToastHost } from '../components/ToastHost';

/**
 * IDE-style shell. Top to bottom:
 *   TitleBar  — drag region with brand mark, Chrome-style tabs, window controls
 *   Work row  — ActivityBar (left rail) + ExplorerPanel (files) + Stage (tabs) + ContextDrawer (collapsible)
 *   StatusBar — workspace, inspect mode, model
 *
 * The browser is the canvas; everything else is chrome around it. Cursor and
 * VSCode use exactly this skeleton.
 */
export function Shell() {
  useTabEvents();
  useDevtoolsEvents();
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Keyboard shortcuts while the React chrome has focus. The mirror case — the
  // embedded web page having focus — is handled in the main process'
  // before-input-event (electron/browser/tabs.ts); the two are mutually
  // exclusive by focus, so a shortcut never double-fires.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // F12 toggles the custom DevTools dock for the active web tab. The store
      // handles the grid guard / non-web / chrome cases.
      if (e.key === 'F12') {
        e.preventDefault();
        useDevtoolsStore.getState().toggle();
        return;
      }

      const mod = e.ctrlKey || e.metaKey;
      const target = e.target as HTMLElement | null;
      const inEditable =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);

      const tabsState = useTabsStore.getState();
      const activeTab = tabsState.tabs.find((t) => t.id === tabsState.activeTabId);
      const isWeb = activeTab?.kind === 'web';

      // Browser navigation shortcuts — only meaningful for an active web tab.
      if (isWeb) {
        // Reload: F5 / Ctrl+R, hard (ignore cache) with Shift. Allowed even from
        // the address bar — browsers reload regardless of focus there.
        if (e.key === 'F5' || (mod && e.key.toLowerCase() === 'r')) {
          e.preventDefault();
          void tabsState.reload(e.shiftKey);
          return;
        }
        // Focus + select the address bar: Ctrl/Cmd+L.
        if (mod && e.key.toLowerCase() === 'l') {
          e.preventDefault();
          useWebPageStore.getState().focusAddressBar();
          return;
        }
        // Find in page: Ctrl/Cmd+F (only here for web tabs — the editor's own
        // Monaco find owns Ctrl+F when an editor tab is active).
        if (mod && e.key.toLowerCase() === 'f') {
          e.preventDefault();
          useWebPageStore.getState().openFind();
          return;
        }
        // Page zoom: Ctrl/Cmd with '='/'+' (in), '-' (out), '0' (reset).
        if (mod && (e.key === '=' || e.key === '+')) {
          e.preventDefault();
          void tabsState.zoom('in');
          return;
        }
        if (mod && e.key === '-') {
          e.preventDefault();
          void tabsState.zoom('out');
          return;
        }
        if (mod && e.key === '0') {
          e.preventDefault();
          void tabsState.zoom('reset');
          return;
        }
        // History: Alt+←/→. Skipped in editable fields so macOS Option+arrow
        // keeps its word-navigation behavior in the address bar.
        if (e.altKey && !inEditable && e.key === 'ArrowLeft') {
          e.preventDefault();
          void tabsState.goBack();
          return;
        }
        if (e.altKey && !inEditable && e.key === 'ArrowRight') {
          e.preventDefault();
          void tabsState.goForward();
          return;
        }
      }

      // App tab shortcuts: Ctrl/Cmd+T new tab, +N new editor, +W close active,
      // +B toggle explorer. Inside a text field they keep native text editing.
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key !== 't' && key !== 'w' && key !== 'b' && key !== 'n') return;
      if (inEditable) return;
      if (key === 'b') {
        e.preventDefault();
        setExplorerOpen((v) => !v);
        return;
      }
      if (key === 't') {
        e.preventDefault();
        void tabsState.newTab();
      } else if (key === 'n') {
        // New untitled editor (VSCode-style); Ctrl+S triggers Save As.
        e.preventDefault();
        void tabsState.newTab('editor');
      } else if (key === 'w') {
        const active = tabsState.activeTabId;
        if (active) {
          e.preventDefault();
          const tab = tabsState.tabs.find((t) => t.id === active);
          if (confirmCloseTab(tab)) void tabsState.closeTab(active);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col bg-surface-page text-fg-primary overflow-hidden">
      <TitleBar />
      <div className="flex-1 min-h-0 flex">
        <ActivityBar
          explorerOpen={explorerOpen}
          onToggleExplorer={() => setExplorerOpen((v) => !v)}
          drawerOpen={drawerOpen}
          onToggleDrawer={() => setDrawerOpen((v) => !v)}
        />
        <ExplorerPanel open={explorerOpen} />
        <main className="flex-1 min-w-0 flex">
          <Stage />
        </main>
        <ContextDrawer open={drawerOpen} onOpenChange={setDrawerOpen} />
      </div>
      <StatusBar />
      <ToastHost />
    </div>
  );
}
