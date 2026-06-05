import type { DevtoolsPanel } from './store';

/**
 * Tool arrangement (Chrome-style main bar vs. bottom drawer) and its
 * localStorage persistence, split out of the devtools store. Pure aside from the
 * `localStorage` access in load/save; the CDP session state stays in store.ts
 * (it's reset per page, never persisted).
 */

/** Where a DevTools tool's tab lives: the main (top) tab bar or the bottom drawer. */
export type ToolLocation = 'main' | 'drawer';

/**
 * One arrangeable DevTools tool. `order` sorts tabs within each location. The
 * arrangement is a user preference persisted to localStorage (like the dock
 * side/size) — Console now defaults to the main bar so it is discoverable
 * without the bottom drawer shortcut.
 */
export type DevtoolsTool = {
  id: DevtoolsPanel;
  location: ToolLocation;
  order: number;
};

/** The default arrangement: every primary tool is visible in the main bar. */
export const DEFAULT_TOOLS: DevtoolsTool[] = [
  { id: 'elements', location: 'main', order: 0 },
  { id: 'console', location: 'main', order: 1 },
  { id: 'network', location: 'main', order: 2 },
  { id: 'application', location: 'main', order: 3 },
  { id: 'rendering', location: 'main', order: 4 },
];

const PANEL_IDS: ReadonlySet<DevtoolsPanel> = new Set<DevtoolsPanel>([
  'elements',
  'console',
  'network',
  'application',
  'rendering',
]);

export const DRAWER_MIN = 80;
export const DRAWER_DEFAULT_HEIGHT = 220;

/* Persisted dock/tool preferences (localStorage). Kept separate from the CDP
 * session state, which is always reset per-page (freshSlices). Best-effort:
 * a malformed/absent blob falls back to defaults, mirroring workspace recents. */
const PREFS_KEY = 'marudesk.devtools.prefs.v2';

export type DevtoolsPrefs = {
  tools: DevtoolsTool[];
  drawerOpen: boolean;
  drawerHeight: number;
  drawerPanel: DevtoolsPanel;
};

/** Coerce arbitrary stored JSON back into a valid tool arrangement (covering
 * every known panel exactly once) so a renamed/removed panel can't corrupt it. */
export function sanitizeTools(input: unknown): DevtoolsTool[] {
  if (!Array.isArray(input)) return DEFAULT_TOOLS.map((t) => ({ ...t }));
  const seen = new Map<DevtoolsPanel, DevtoolsTool>();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = r.id as DevtoolsPanel;
    if (!PANEL_IDS.has(id) || seen.has(id)) continue;
    seen.set(id, {
      id,
      location: r.location === 'drawer' ? 'drawer' : 'main',
      order: typeof r.order === 'number' && Number.isFinite(r.order) ? r.order : 0,
    });
  }
  // Backfill any panel the stored blob didn't mention (e.g. a newly-added one)
  // from the defaults, so the union is always fully covered.
  for (const def of DEFAULT_TOOLS) {
    if (!seen.has(def.id)) seen.set(def.id, { ...def });
  }
  return [...seen.values()];
}

export function loadPrefs(): DevtoolsPrefs {
  const fallback: DevtoolsPrefs = {
    tools: DEFAULT_TOOLS.map((t) => ({ ...t })),
    drawerOpen: false,
    drawerHeight: DRAWER_DEFAULT_HEIGHT,
    drawerPanel: 'console',
  };
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null');
    if (!parsed || typeof parsed !== 'object') return fallback;
    const tools = sanitizeTools(parsed.tools);
    const drawerPanel = PANEL_IDS.has(parsed.drawerPanel)
      ? (parsed.drawerPanel as DevtoolsPanel)
      : 'console';
    return {
      tools,
      drawerOpen: typeof parsed.drawerOpen === 'boolean' ? parsed.drawerOpen : false,
      drawerHeight:
        typeof parsed.drawerHeight === 'number' && Number.isFinite(parsed.drawerHeight)
          ? Math.max(DRAWER_MIN, Math.round(parsed.drawerHeight))
          : DRAWER_DEFAULT_HEIGHT,
      drawerPanel,
    };
  } catch {
    return fallback;
  }
}

export function savePrefs(p: DevtoolsPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // best-effort (private mode / quota)
  }
}

/** Pull the persistable preference subset out of the live store state. */
export function snapshotPrefs(s: {
  tools: DevtoolsTool[];
  drawerOpen: boolean;
  drawerHeight: number;
  drawerPanel: DevtoolsPanel;
}): DevtoolsPrefs {
  return {
    tools: s.tools,
    drawerOpen: s.drawerOpen,
    drawerHeight: s.drawerHeight,
    drawerPanel: s.drawerPanel,
  };
}

/** First tool (by order) in a location, or null when the location is empty. */
export function firstInLocation(tools: DevtoolsTool[], loc: ToolLocation): DevtoolsPanel | null {
  const inLoc = tools.filter((t) => t.location === loc).sort((a, b) => a.order - b.order);
  return inLoc[0]?.id ?? null;
}
