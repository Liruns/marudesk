import { app } from 'electron';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { isTabGroupColor, type TabGroupColor } from '../../shared/browser';
import { atomicWriteFile } from '../fs-safe';
import { getActiveTabId, getTabGroup, tabValues } from './state';

/**
 * Full tab-session persistence (Settings → Data & Storage → "Restore tabs on
 * launch"). Where pinned-session.ts persists only pinned tabs, this captures the
 * WHOLE restorable tab set — every web page and saved-editor tab, in strip order,
 * with its pinned flag — plus which one was active, so the next launch reopens
 * the session like Chrome's "Continue where you left off".
 *
 * Tab groups round-trip too: `groups` holds each group's name/color/collapsed
 * state, and a spec's optional `group` field indexes into it. Both fields are
 * additive/optional so sessions written before groups existed still restore
 * (no `groups` array → every tab ungrouped), and an old build reading a new
 * file simply ignores the extra fields.
 *
 * Only kinds with restorable state are saved (web URLs, editor file paths);
 * transient kinds (home/terminal/agent/settings/search) carry nothing to bring
 * back and are skipped. Writes are atomic + fire-and-forget; the launch-time
 * read is synchronous so tabs exist, in order, before the stage paints.
 */

export type TabSessionSpec =
  | { kind: 'web'; url: string; pinned: boolean; group?: number }
  | { kind: 'editor'; filePath: string; pinned: boolean; group?: number };

/** A saved tab group; specs reference it by index via their `group` field. */
export type TabSessionGroup = {
  name: string;
  color: TabGroupColor;
  collapsed: boolean;
};

export type TabSession = {
  tabs: TabSessionSpec[];
  /** Index into `tabs` of the tab that was active, or -1 (activate the first). */
  activeIndex: number;
  groups: TabSessionGroup[];
};

function sessionFile(): string {
  return path.join(app.getPath('userData'), 'tab-session.json');
}

/** The restorable open tabs in strip order, plus the active tab's index. */
function sessionFromState(): TabSession {
  const tabs: TabSessionSpec[] = [];
  const groups: TabSessionGroup[] = [];
  // Group indices are assigned lazily as a SAVED member references the group,
  // which automatically compacts away groups whose members are all transient
  // (nothing restorable would have re-created them anyway).
  const groupIndex = new Map<string, number>();
  let activeIndex = -1;
  const activeId = getActiveTabId();
  for (const rec of tabValues()) {
    let spec: TabSessionSpec | null = null;
    if (rec.kind === 'web' && rec.view) {
      const url = rec.view.webContents.getURL();
      spec = { kind: 'web', url: url && url !== 'about:blank' ? url : '', pinned: !!rec.pinned };
    } else if (rec.kind === 'editor' && rec.filePath) {
      spec = { kind: 'editor', filePath: rec.filePath, pinned: !!rec.pinned };
    }
    if (!spec) continue;
    if (rec.groupId) {
      const group = getTabGroup(rec.groupId);
      if (group) {
        let idx = groupIndex.get(group.id);
        if (idx === undefined) {
          idx = groups.length;
          groupIndex.set(group.id, idx);
          groups.push({
            name: group.name,
            color: group.color,
            collapsed: group.collapsed,
          });
        }
        spec.group = idx;
      }
    }
    if (rec.id === activeId) activeIndex = tabs.length;
    tabs.push(spec);
  }
  return { tabs, activeIndex, groups };
}

/** Persist the current tab session (fire-and-forget; never throws to caller). */
export function saveTabSession(): void {
  try {
    void atomicWriteFile(sessionFile(), JSON.stringify(sessionFromState()));
  } catch {
    // Best-effort — a failed session write must never break tab operations.
  }
}

function isSpec(x: unknown): x is TabSessionSpec {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (typeof o.pinned !== 'boolean') return false;
  if (o.group !== undefined && typeof o.group !== 'number') return false;
  if (o.kind === 'web') return typeof o.url === 'string';
  if (o.kind === 'editor') return typeof o.filePath === 'string';
  return false;
}

function isGroup(x: unknown): x is TabSessionGroup {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.name === 'string' &&
    isTabGroupColor(o.color) &&
    typeof o.collapsed === 'boolean'
  );
}

/** Read the saved tab session synchronously (startup restore). Empty on any error. */
export function loadTabSession(): TabSession {
  const empty: TabSession = { tabs: [], activeIndex: -1, groups: [] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(sessionFile(), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return empty;
    const o = parsed as Record<string, unknown>;
    // `groups` is optional on disk (pre-group sessions); a malformed array is
    // dropped wholesale, which simply restores every tab ungrouped.
    const groups = Array.isArray(o.groups) ? o.groups.filter(isGroup) : [];
    const tabs = (Array.isArray(o.tabs) ? o.tabs.filter(isSpec) : []).map(
      (spec): TabSessionSpec => {
        // Keep only trustworthy group references (an integer index into the
        // validated `groups`); anything else restores the tab ungrouped.
        if (
          spec.group !== undefined &&
          Number.isInteger(spec.group) &&
          spec.group >= 0 &&
          spec.group < groups.length
        ) {
          return spec;
        }
        return spec.kind === 'web'
          ? { kind: 'web', url: spec.url, pinned: spec.pinned }
          : { kind: 'editor', filePath: spec.filePath, pinned: spec.pinned };
      },
    );
    const activeIndex =
      typeof o.activeIndex === 'number' && o.activeIndex >= 0 && o.activeIndex < tabs.length
        ? o.activeIndex
        : -1;
    return { tabs, activeIndex, groups };
  } catch {
    return empty;
  }
}
