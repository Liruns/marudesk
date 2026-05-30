import { useEffect, useState } from 'react';
import { ActivityBar } from '../components/ActivityBar';
import { StatusBar } from '../components/StatusBar';
import { TitleBar } from '../components/TitleBar';
import { Stage } from '../features/tabs/Stage';
import { useTabsStore } from '../features/tabs/store';
import { useTabEvents } from '../features/tabs/useTabEvents';
import { ExplorerPanel } from '../features/workspace/ExplorerPanel';
import { confirmCloseTab } from '../features/editor/store';
import { ContextDrawer } from '../features/context/ContextDrawer';

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
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Chrome-style tab shortcuts: Ctrl/Cmd+T new tab, Ctrl/Cmd+W close active.
  // Inputs and contentEditable keep their default text-editing behavior.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // F12 toggles the embedded browser DevTools for the active web tab. The
      // in-page F12 (main process before-input-event) covers the case where the
      // page itself is focused; this covers F12 while the React chrome has focus.
      if (e.key === 'F12') {
        const b = useTabsStore.getState();
        const active = b.tabs.find((t) => t.id === b.activeTabId);
        if (active?.kind === 'web') {
          e.preventDefault();
          void window.marudesk.invoke('browser:toggle-devtools');
        }
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key !== 't' && key !== 'w' && key !== 'b' && key !== 'n') return;
      // Inside a text field these chords keep their native text-editing
      // behavior; only hijack them elsewhere.
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (key === 'b') {
        e.preventDefault();
        setExplorerOpen((v) => !v);
        return;
      }
      const tabsState = useTabsStore.getState();
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
    </div>
  );
}
