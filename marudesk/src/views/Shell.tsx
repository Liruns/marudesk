import { useEffect, useRef, useState } from 'react';
import { ActivityBar } from '../components/ActivityBar';
import { StatusBar } from '../components/StatusBar';
import { TitleBar } from '../components/TitleBar';
import { useTabsStore } from '../features/tabs/store';
import { useGridStore } from '../features/tabs/grid';
import { WorkspaceStage } from '../features/workspaces/WorkspaceStage';
import { useWebPageStore } from '../features/browser/store';
import { useBookmarksStore } from '../features/browser/bookmarks';
import { useTabEvents } from '../features/tabs/useTabEvents';
import { useDiagnosticsEvents } from '../features/diagnostics/useDiagnosticsEvents';
import { useDevtoolsStore } from '../features/devtools/store';
import { useDevtoolsEvents } from '../features/devtools/useDevtoolsEvents';
import { ExplorerPanel } from '../features/workspace/ExplorerPanel';
import { SourceControlPanel } from '../features/git/SourceControlPanel';
import { SearchPanel } from '../features/search/SearchPanel';
import { QuickOpen } from '../features/search/QuickOpen';
import { TabPalette } from '../features/tabs/TabPalette';
import { useSearchStore } from '../features/search/store';
import { confirmCloseTab } from '../features/editor/store';
import { ContextDrawer } from '../features/context/ContextDrawer';
import { useComposerStore } from '../features/composer/store';
import { useContextSync } from '../features/agent/context-sync';
import { ToastHost } from '../components/ToastHost';
import { toast } from '../lib/toast';
import { useI18n } from '../i18n/useI18n';
import { Tour } from '../features/tour/Tour';
import { openSettingsTab, useSettingsStore } from '../features/settings/store';
import { UI_ZOOM_MAX, UI_ZOOM_MIN } from '../../shared/settings';
import type { EventPayload } from '../../shared/ipc';

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
 * Run a tab/split-pane shortcut against the live state. Shared by the window
 * keydown handler (React chrome focused) and the `app:tab-shortcut` event (a
 * focused web view forwarded it from main's before-input-event). Tab `cycle`
 * wraps; `jump` is 1-based with digit 9 meaning the last tab — Chrome parity.
 * Pane ops delegate to the grid store (no-ops outside a split).
 */
function runShortcut(p: EventPayload<'app:tab-shortcut'>): void {
  if (p.type === 'pane-cycle') {
    useGridStore.getState().focusAdjacent(p.dir);
    return;
  }
  if (p.type === 'pane-maximize') {
    useGridStore.getState().maximizeFocused();
    return;
  }
  if (p.type === 'close') {
    // Ctrl/Cmd+W forwarded from a focused web view. Mirror the chrome-focused
    // path: close the active tab (with the dirty-discard prompt), never the app.
    const cst = useTabsStore.getState();
    const active = cst.activeTabId;
    if (!active) return;
    const tab = cst.tabs.find((t) => t.id === active);
    if (confirmCloseTab(tab)) void cst.closeTab(active);
    return;
  }
  const st = useTabsStore.getState();
  const { tabs, activeTabId } = st;
  if (tabs.length === 0) return;
  let idx: number;
  if (p.type === 'cycle') {
    const cur = tabs.findIndex((t) => t.id === activeTabId);
    idx = ((cur < 0 ? 0 : cur) + p.dir + tabs.length) % tabs.length;
  } else {
    idx = p.digit >= 9 ? tabs.length - 1 : Math.min(p.digit - 1, tabs.length - 1);
  }
  const target = tabs[idx];
  if (target && target.id !== activeTabId) void st.activateTab(target.id);
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
  // Bridge checker diagnostics (Problems indicator + Monaco squiggles).
  useDiagnosticsEvents();
  // Mirror editor buffers + explorer state to main for the built-in context MCP.
  useContextSync();
  const { t } = useI18n();
  const prevAgentStatusRef = useRef<string>('idle');
  // The left rail shows one panel at a time (VSCode-style): toggling a view
  // button opens that view or collapses the rail if it's already active.
  const [leftPanel, setLeftPanel] = useState<LeftPanel>('explorer');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [tabPalette, setTabPalette] = useState(false);

  // Toggle a left-rail view: clicking the active view collapses the rail.
  const toggleLeft = (panel: Exclude<LeftPanel, null>) =>
    setLeftPanel((cur) => (cur === panel ? null : panel));

  // Open the chat drawer when a stage element pick / askAgent asks for it (the
  // composer store bumps a nonce). A store SUBSCRIPTION (not an effect on the
  // selected value) so the setState happens in an external-event callback; the
  // ref means a repeat pick re-opens a drawer the user closed, and nothing
  // fires on mount. The "AI Chat (CLI)" terminal tab is a separate, always-
  // available surface (Home launcher / `marudesk` command), not a routing mode.
  const drawerNonceSeen = useRef(useComposerStore.getState().drawerOpenNonce);
  useEffect(
    () =>
      useComposerStore.subscribe((s) => {
        if (s.drawerOpenNonce === drawerNonceSeen.current) return;
        drawerNonceSeen.current = s.drawerOpenNonce;
        setDrawerOpen(true);
      }),
    [],
  );

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
      // Open (or focus) the Settings tab — Ctrl/Cmd+, (VSCode/Chrome parity).
      if (mod && !e.shiftKey && e.key === ',') {
        e.preventDefault();
        void openSettingsTab();
        return;
      }
      // Tab switcher palette (Ctrl/Cmd+Shift+A) and reopen-closed-tab
      // (Ctrl/Cmd+Shift+T) — Chrome parity, allowed from any focus.
      if (mod && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setTabPalette(true);
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        void useTabsStore.getState().reopenClosedTab();
        return;
      }
      // Library panel (Bookmarks | History) — Ctrl/Cmd+Shift+O (Chrome's
      // bookmark-manager shortcut). The panel renders beside the browser stage,
      // so it only shows while a web tab's canvas is active.
      if (mod && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        useBookmarksStore.getState().toggleLibrary();
        return;
      }

      // Tab navigation (Chrome parity), allowed from any focus incl. text fields
      // — browsers switch tabs even from the address bar:
      //   Ctrl+Tab / Ctrl+Shift+Tab — cycle tabs (wraps)
      //   Ctrl/Cmd+1…9              — jump to tab N (9 = last)
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        runShortcut({ type: 'cycle', dir: e.shiftKey ? -1 : 1 });
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        runShortcut({ type: 'jump', digit: Number(e.key) });
        return;
      }
      // Split-pane shortcuts: Ctrl+Alt+Arrow cycles pane focus, Ctrl+Shift+Enter
      // zooms the focused pane (both no-op outside a split).
      if (
        e.ctrlKey &&
        e.altKey &&
        (e.key === 'ArrowLeft' ||
          e.key === 'ArrowRight' ||
          e.key === 'ArrowUp' ||
          e.key === 'ArrowDown')
      ) {
        e.preventDefault();
        runShortcut({
          type: 'pane-cycle',
          dir: e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1,
        });
        return;
      }
      if (e.ctrlKey && e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        runShortcut({ type: 'pane-maximize' });
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

  // Tab navigation forwarded from a focused web view (main intercepts Ctrl+Tab /
  // Ctrl+Cmd+1–9 there since the page holds keyboard focus). Same handler the
  // window keydown uses when the React chrome is focused.
  useEffect(() => {
    return window.marudesk.on('app:tab-shortcut', (p) => runShortcut(p));
  }, []);

  // Agent notification: toast when the AI finishes or asks a question while the
  // chat surface is not visible, so the user notices from anywhere in the app.
  useEffect(() => {
    const handle = (status: string) => {
      const prev = prevAgentStatusRef.current;
      prevAgentStatusRef.current = status;
      const wasBusy = prev === 'thinking' || prev === 'working';
      if (!wasBusy || (status !== 'completed' && status !== 'waiting_for_user')) return;
      const tabs = useTabsStore.getState();
      const active = tabs.tabs.find((tab) => tab.id === tabs.activeTabId);
      if (drawerOpen || active?.kind === 'agent') return;
      toast({
        title: t(status === 'completed' ? 'agent.notify.completed' : 'agent.notify.question'),
        variant: status === 'completed' ? 'success' : 'warning',
      });
    };
    const off1 = window.marudesk.on('agent:event', (s) => handle(s.status));
    const off2 = window.marudesk.on('agent:workspace-event', (e) => handle(e.state.status));
    return () => { off1(); off2(); };
  }, [drawerOpen, t]);

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
        <main data-stage-region className="flex-1 min-w-0 flex">
          <WorkspaceStage />
        </main>
        <ContextDrawer open={drawerOpen} onOpenChange={setDrawerOpen} />
      </div>
      <StatusBar />
      <ToastHost />
      <Tour />
      {quickOpen ? <QuickOpen onClose={() => setQuickOpen(false)} /> : null}
      {tabPalette ? <TabPalette onClose={() => setTabPalette(false)} /> : null}
    </div>
  );
}
