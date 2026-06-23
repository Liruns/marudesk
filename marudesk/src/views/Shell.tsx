import { useEffect, useRef } from 'react';
import { TitleBar } from '../components/TitleBar';
import { useTabsStore } from '../features/tabs/store';
import { useGridStore } from '../features/tabs/grid';
import { MainStage } from '../features/work-graph/MainStage';
import { InstrumentDock } from '../features/work-graph/InstrumentDock';
import { InstrumentRail } from '../features/work-graph/InstrumentRail';
import { openInstrument, reopenTabInstrument, useInstrumentStore } from '../features/work-graph/instrument';
import { useWorkspaceDeckStore } from '../features/workspaces/store';
import { EvidenceStrip } from '../features/work-graph/EvidenceStrip';
import { FlightLog } from '../features/work-graph/FlightLog';
import { CommandPalette } from '../features/commands/CommandPalette';
import { useCommandPaletteStore } from '../features/commands/command-palette-store';
import { useOverlayStore } from '../features/commands/overlay-store';
import { useWorkGraphStore } from '../features/work-graph/store';
import { dockRenderedThreadId } from '../features/work-graph/taskThreads';
import { cardThreadId } from '../features/agent/cardThreads';
import { useWebPageStore } from '../features/browser/store';
import { useBookmarksStore } from '../features/browser/bookmarks';
import { useSyncNativeLabels } from '../features/browser/useSyncNativeLabels';
import { useTabEvents } from '../features/tabs/useTabEvents';
import { useDiagnosticsEvents } from '../features/diagnostics/useDiagnosticsEvents';
import { useDevtoolsStore } from '../features/devtools/store';
import { useDevtoolsEvents } from '../features/devtools/useDevtoolsEvents';
import { QuickOpen } from '../features/search/QuickOpen';
import { TabPalette } from '../features/tabs/TabPalette';
import { confirmCloseTab } from '../features/editor/store';
import { useContextSync } from '../features/agent/context-sync';
import { ToastHost } from '../components/ToastHost';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { toast } from '../lib/toast';
import { useI18n } from '../i18n/useI18n';
import { Tour } from '../features/tour/Tour';
import { hasSeenTour, useTourStore } from '../features/tour/tourStore';
import { openSettingsTab, useSettingsStore } from '../features/settings/store';
import { UI_ZOOM_MAX, UI_ZOOM_MIN } from '../../shared/settings';
import type { EventPayload } from '../../shared/ipc';
import type { AgentStatus, AgentThreadEvent } from '../../shared/agent';

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
 * Mission Control shell. Top to bottom:
 *   TitleBar      — brand mark, flight status, window controls
 *   Main row      — the Task graph (or a summoned instrument) + the Instrument Dock
 *   EvidenceStrip — the selected task's acceptance verdicts (system-filled)
 *
 * The Task graph is the home; tools are instruments a task summons, never
 * persistent windows (docs/mission-control-redesign.md).
 */
export function Shell() {
  useTabEvents();
  useDevtoolsEvents();
  // Bridge checker diagnostics (Problems indicator + Monaco squiggles).
  useDiagnosticsEvents();
  // Mirror editor buffers + explorer state to main for the built-in context MCP.
  useContextSync();
  // Keep the native menus built in main (web-tab context menu, close-to-tray
  // menu) in the user's language.
  useSyncNativeLabels();
  const { t } = useI18n();
  // Last-seen status per agent thread, so the busy→done edge that drives the
  // completion toast is detected independently for each conversation (the dock
  // chat, an AI Chat instrument, and any background thread all advance at once).
  const prevAgentStatusByThreadRef = useRef<Map<string, AgentStatus>>(new Map());
  // Quick Open (Ctrl+P) + Tab Palette (Ctrl+Shift+A) live in a shared store so the
  // ⌘K palette can open them too; the Shell still owns rendering them.
  const quickOpen = useOverlayStore((s) => s.quickOpen);
  const tabPalette = useOverlayStore((s) => s.tabPalette);

  // First-run onboarding: auto-start the product tour exactly once. Mission Control
  // dropped a new user onto an empty stage with no guidance — yet a built, localized,
  // a11y-correct Tour (welcome · ⌘K · goal · implement · apply · workspace · flight
  // log) already existed and only fired from a ⌘K verb you couldn't find. Fire it on
  // first launch; close() marks it seen so it shows exactly once. (e2e/screens seed
  // the seen flag in launchApp so the overlay never blocks automated runs.)
  useEffect(() => {
    if (!hasSeenTour()) useTourStore.getState().start();
  }, []);

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
      //   Ctrl/Cmd+P — quick-open (go to file)
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        useOverlayStore.getState().showQuickOpen();
        return;
      }
      // Open (or focus) the Settings tab — Ctrl/Cmd+, (VSCode/Chrome parity).
      if (mod && !e.shiftKey && e.key === ',') {
        e.preventDefault();
        void openSettingsTab();
        return;
      }
      // Command palette — Ctrl/Cmd+K. The "summon anything" entry for Mission
      // Control surfaces (Settings, AI Chat, editor, terminal) that have no tab
      // strip to open them from.
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        useCommandPaletteStore.getState().toggle();
        return;
      }
      // Tab switcher palette (Ctrl/Cmd+Shift+A) and reopen-closed-tab
      // (Ctrl/Cmd+Shift+T) — Chrome parity, allowed from any focus.
      if (mod && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        useOverlayStore.getState().showTabPalette();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        void reopenTabInstrument();
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

      // App tab shortcuts: Ctrl/Cmd+T new web instrument, +N new editor, +W close
      // active. Inside a text field they keep native text editing. In Mission
      // Control the only tab-rendering surface is the InstrumentStage, so these
      // must summon their surface as the full-area instrument (mirroring the ⌘K
      // palette) rather than create a never-hosted orphan tab.
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key !== 't' && key !== 'w' && key !== 'n') return;
      if (inEditable) return;
      const workspaceId = useWorkspaceDeckStore.getState().activeWorkspaceId ?? undefined;
      if (key === 't') {
        // No "new home tab" exists in Mission Control; a blank runtime-aware web
        // surface is the natural Ctrl+T (matches the ⌘K "New Web Tab" command).
        e.preventDefault();
        void openInstrument('web');
      } else if (key === 'n') {
        // New untitled editor (VSCode-style); Ctrl+S triggers Save As. Opened AS
        // the visible instrument (mirrors the ⌘K "New Editor" command).
        e.preventDefault();
        void openInstrument('editor', { workspaceId });
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

  // Agent notification: toast when the AI finishes or asks a question while its
  // thread is NOT the visible agent surface, so the user notices from anywhere in
  // the app. Driven off `agent:thread-event` because it is the only stream that
  // carries a threadId AND fires for EVERY thread (active or background) — so we
  // can tell which conversation completed and whether the user is looking at it.
  //
  // In Mission Control the visible agent surfaces are thread-scoped, not "the
  // active tab is kind 'agent'": either the open AI Chat *instrument*
  // (useInstrumentStore, kind 'agent' → its tab's cardThread) OR the selected
  // task's per-task DOCK CHAT (TaskChat, the selected task's taskThread). Suppress
  // only when the completed event's thread is one of those; background/off-screen
  // completions still toast. The busy→done edge is tracked per thread so a
  // background turn finishing never gets masked by another thread's status.
  useEffect(() => {
    const prevByThread = prevAgentStatusByThreadRef.current;
    return window.marudesk.on('agent:thread-event', (event: AgentThreadEvent) => {
      const { threadId, state } = event;
      const status = state.status;
      const prev = prevByThread.get(threadId) ?? 'idle';
      prevByThread.set(threadId, status);
      const wasBusy = prev === 'thinking' || prev === 'working';
      if (!wasBusy || (status !== 'completed' && status !== 'waiting_for_user')) return;

      // The AI Chat instrument's thread(s) — an 'agent' instrument open in EITHER
      // pane of a split is a visible agent surface, so suppress both.
      const instrument = useInstrumentStore.getState();
      const visibleAgentThreads = new Set<string>();
      if (instrument.kind === 'agent' && instrument.tabId) {
        const tid = cardThreadId(instrument.tabId);
        if (tid) visibleAgentThreads.add(tid);
      }
      if (instrument.secondaryKind === 'agent' && instrument.secondaryTabId) {
        const tid = cardThreadId(instrument.secondaryTabId);
        if (tid) visibleAgentThreads.add(tid);
      }
      // The thread the dock chat is ACTUALLY rendering (the selected task's own
      // thread, or — when acquiring it failed — the workspace conversation it
      // falls back to and visibly shows). Published by the dock's TaskChat so a
      // fallback completion on a visible thread doesn't wrongly toast.
      const dockThreadId = dockRenderedThreadId();

      if (visibleAgentThreads.has(threadId) || threadId === dockThreadId) return;
      toast({
        title: t(status === 'completed' ? 'agent.notify.completed' : 'agent.notify.question'),
        variant: status === 'completed' ? 'success' : 'warning',
      });
    });
  }, [t]);

  // NOTE: the per-thread busy→done tracking map (prevAgentStatusByThreadRef) is
  // intentionally NOT pruned against `agent:threads`. That push is the GLOBAL
  // (workspaceId === null) thread list only, so pruning against it wiped the
  // tracking entry for every WORKSPACE-scoped task thread on each tick and then
  // silently suppressed its completion toast (busy→done resolved as idle→done).
  // The map grows by one tiny enum per distinct thread id seen in a session —
  // negligible — so we keep it unpruned rather than break background toasts. A
  // correct prune would need an authoritative per-thread close signal.

  // The agent's `create_task` MCP tool: draw the task node it asked for on the
  // Mission Control graph (placed in free space).
  useEffect(() => {
    return window.marudesk.on('workos:create-task', (spec) => {
      useWorkGraphStore.getState().addTaskFromAgent(spec);
    });
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col bg-surface-page text-fg-primary overflow-hidden">
      <TitleBar />
      <div className="flex-1 min-h-0 flex">
        {/* Always-visible launcher for the staple tools — the discoverable front
            door the Mission Control redesign removed with the legacy ActivityBar.
            Each button summons the same instrument as the matching ⌘K command. */}
        <ErrorBoundary label="rail">
          <InstrumentRail />
        </ErrorBoundary>
        {/* The Task graph is the home; a selected node opens the Instrument Dock,
            and a summoned tool docks BESIDE the graph (resizable Workbench) rather
            than replacing it — see MainStage. */}
        <main data-stage-region className="flex-1 min-w-0 flex">
          <ErrorBoundary label="stage">
            <MainStage />
          </ErrorBoundary>
        </main>
        <ErrorBoundary label="dock">
          <InstrumentDock />
        </ErrorBoundary>
      </div>
      <EvidenceStrip />
      <ToastHost />
      <Tour />
      <FlightLog />
      <CommandPalette />
      {quickOpen ? <QuickOpen onClose={() => useOverlayStore.getState().hideQuickOpen()} /> : null}
      {tabPalette ? <TabPalette onClose={() => useOverlayStore.getState().hideTabPalette()} /> : null}
    </div>
  );
}
