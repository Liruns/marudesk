import type { StoreApi } from 'zustand';
import { DEFAULT_SIZE, MIN_SIZE } from './store-internals';
import { DRAWER_MIN, firstInLocation, savePrefs, snapshotPrefs } from './store-prefs';
import type { DevtoolsState, DevtoolsActions } from './store';

type DevtoolsStore = DevtoolsState & DevtoolsActions;
type SetState = StoreApi<DevtoolsStore>['setState'];
type GetState = StoreApi<DevtoolsStore>['getState'];

type DockActions = Pick<
  DevtoolsActions,
  | 'setWindowMode'
  | 'setPanel'
  | 'setSide'
  | 'setSize'
  | 'setDrawerPanel'
  | 'toggleDrawer'
  | 'setDrawerOpen'
  | 'setDrawerHeight'
  | 'moveTool'
>;

/**
 * Dock layout actions for the devtools store: which side/size the dock takes,
 * the active main + drawer panel, drawer open/height, and tool arrangement
 * (persisted to localStorage). No CDP — panel activation is delegated to the
 * session machine via get()._enablePanel. Extracted from store.ts as a slice.
 */
export function createDockSlice(set: SetState, get: GetState): DockActions {
  return {
    setWindowMode: (on) => set({ windowMode: on }),

    setPanel: (panel) => {
      if (get().panel === panel) return;
      set({ panel });
      if (get().session === 'attached') void get()._enablePanel(panel);
    },

    setSide: (side) => set({ side, size: DEFAULT_SIZE[side] }),

    setSize: (size) => set({ size: Math.max(MIN_SIZE, Math.round(size)) }),

    /* ── bottom drawer + tool arrangement ───────────────────────────────── */

    setDrawerPanel: (panel) => {
      if (get().drawerPanel === panel) return;
      set({ drawerPanel: panel });
      savePrefs(snapshotPrefs(get()));
      if (get().session === 'attached') void get()._enablePanel(panel);
    },

    toggleDrawer: () => get().setDrawerOpen(!get().drawerOpen),

    setDrawerOpen: (open) => {
      if (get().drawerOpen === open) return;
      set({ drawerOpen: open });
      savePrefs(snapshotPrefs(get()));
      // Enabling the drawer's panel lazily mirrors setPanel — its CDP domains
      // (e.g. Network) only turn on when the surface is actually shown.
      if (open && get().session === 'attached') void get()._enablePanel(get().drawerPanel);
    },

    setDrawerHeight: (height) => {
      set({ drawerHeight: Math.max(DRAWER_MIN, Math.round(height)) });
      savePrefs(snapshotPrefs(get()));
    },

    moveTool: (id, location) => {
      const s = get();
      const tool = s.tools.find((t) => t.id === id);
      if (!tool || tool.location === location) return;
      // Append to the end of the destination location's order.
      const maxOrder = s.tools
        .filter((t) => t.location === location)
        .reduce((m, t) => Math.max(m, t.order), -1);
      const tools = s.tools.map((t) =>
        t.id === id ? { ...t, location, order: maxOrder + 1 } : t,
      );

      const patch: Partial<DevtoolsState> = { tools };
      // If the moved tool was the active tab of its old location, hand activity
      // to the next remaining tool there so the surface never points at a tool
      // that's no longer present.
      if (tool.location === 'main' && s.panel === id) {
        const next = firstInLocation(tools, 'main');
        if (next) patch.panel = next;
      }
      if (tool.location === 'drawer' && s.drawerPanel === id) {
        const next = firstInLocation(tools, 'drawer');
        if (next) patch.drawerPanel = next;
      }
      // Make the moved tool the active tab in its NEW location, and reveal the
      // drawer when something lands there (so "Move to bottom" is visible).
      if (location === 'main') patch.panel = id;
      else {
        patch.drawerPanel = id;
        patch.drawerOpen = true;
      }

      set(patch);
      savePrefs(snapshotPrefs(get()));
      if (get().session === 'attached') void get()._enablePanel(id);
    },
  };
}
