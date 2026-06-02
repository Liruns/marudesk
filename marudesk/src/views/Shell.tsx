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
import { SourceControlPanel } from '../features/git/SourceControlPanel';
import { SearchPanel } from '../features/search/SearchPanel';
import { QuickOpen } from '../features/search/QuickOpen';
import { useSearchStore } from '../features/search/store';
import { confirmCloseTab } from '../features/editor/store';
import { ContextDrawer } from '../features/context/ContextDrawer';
import { useContextSync } from '../features/agent/context-sync';
import { ToastHost } from '../components/ToastHost';
import { useSettingsStore } from '../features/settings/store';
import { UI_ZOOM_MAX, UI_ZOOM_MIN } from '../../shared/settings';

/** The single active left-rail panel, or null when the rail is collapsed. */
type LeftPanel = 'explorer' | 'search' | 'sourceControl' | null;

/**
 * Step the persisted whole-UI zoom (the Settings "Interface zoom") by ±10%, or
 * reset to 100%. This is the single source of truth for app zoom, so the
 * keyboard shortcut and the Settings slider can never diverge — see the host
 * before-input-event in electron/main.ts that drives this.
 */
function adjustUiZoom(dir: 'in' | 'out' | 'reset'): void {
  const { settings, update } = useSettingsStore.getState();
  const cur = settings.appearance.uiZoom;
  const next =
    dir === 'reset'
      ? 100
      : Math.min(
          UI_ZOOM_MAX,
          Math.max(UI_ZOOM_MIN, cur + (dir === 'in' ? 10 : -10)),
        );
  if (next !== cur) void update({ appearance: { uiZoom: next } });
}

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
  // Mirror editor buffers + explorer state to main for the built-in context MCP.
  useContextSync();
  // The left rail shows one panel at a time (VSCode-style): toggling a view
  // button opens that view or collapses the rail if it's already active.
  const [leftPanel, setLeftPanel] = useState<LeftPanel>('explorer');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);

  // Toggle a left-rail view: clicking the active view collapses the rail.
  const toggleLeft = (panel: Exclude<LeftPanel, null>) =>
    setLeftPanel((cur) => (cur === panel ? null : panel));

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

      // App-wide navigation, independent of the active tab kind and allowed even
      // from a text field (these aren't native text-editing keys):
      //   Ctrl/Cmd+P        — quick-open (go to file)
      //   Ctrl/Cmd+Shift+F  — open + focus the content-search panel
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setQuickOpen(true);
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setLeftPanel('search');
        useSearchStore.getState().requestFocus();
        return;
      }

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
        // Zoom (Ctrl/Cmd +/-/0) is handled app-wide via the `app:ui-zoom` event
        // below — main's host before-input-event intercepts the accelerator so
        // Chromium's built-in zoom can't fire, then forwards the intent here.
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
        toggleLeft('explorer');
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

  // App zoom, forwarded from main (it intercepts the Ctrl/Cmd +/-/0 accelerator
  // on the host so the built-in zoom can't double-apply). A web tab zooms the
  // page (matching a browser); every other surface scales the whole UI.
  useEffect(() => {
    return window.marudesk.on('app:ui-zoom', (dir) => {
      const tabsState = useTabsStore.getState();
      const active = tabsState.tabs.find((t) => t.id === tabsState.activeTabId);
      if (active?.kind === 'web') void tabsState.zoom(dir);
      else adjustUiZoom(dir);
    });
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col bg-surface-page text-fg-primary overflow-hidden">
      <TitleBar />
      <div className="flex-1 min-h-0 flex">
        <ActivityBar
          explorerOpen={leftPanel === 'explorer'}
          onToggleExplorer={() => toggleLeft('explorer')}
          searchOpen={leftPanel === 'search'}
          onToggleSearch={() => toggleLeft('search')}
          sourceControlOpen={leftPanel === 'sourceControl'}
          onToggleSourceControl={() => toggleLeft('sourceControl')}
          drawerOpen={drawerOpen}
          onToggleDrawer={() => setDrawerOpen((v) => !v)}
        />
        <ExplorerPanel
          open={leftPanel === 'explorer'}
          onRequestClose={() => setLeftPanel(null)}
        />
        <SearchPanel
          open={leftPanel === 'search'}
          onRequestClose={() => setLeftPanel(null)}
        />
        <SourceControlPanel
          open={leftPanel === 'sourceControl'}
          onRequestClose={() => setLeftPanel(null)}
        />
        <main className="flex-1 min-w-0 flex">
          <Stage />
        </main>
        <ContextDrawer open={drawerOpen} onOpenChange={setDrawerOpen} />
      </div>
      <StatusBar />
      <ToastHost />
      {quickOpen ? <QuickOpen onClose={() => setQuickOpen(false)} /> : null}
    </div>
  );
}
