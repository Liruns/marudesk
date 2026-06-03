import { app } from 'electron';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { atomicWriteFile } from '../fs-safe';
import { getActiveTabId, tabValues } from './state';

/**
 * Full tab-session persistence (Settings → Data & Storage → "Restore tabs on
 * launch"). Where pinned-session.ts persists only pinned tabs, this captures the
 * WHOLE restorable tab set — every web page and saved-editor tab, in strip order,
 * with its pinned flag — plus which one was active, so the next launch reopens
 * the session like Chrome's "Continue where you left off".
 *
 * Only kinds with restorable state are saved (web URLs, editor file paths);
 * transient kinds (home/terminal/agent/settings/search) carry nothing to bring
 * back and are skipped. Writes are atomic + fire-and-forget; the launch-time
 * read is synchronous so tabs exist, in order, before the stage paints.
 */

export type TabSessionSpec =
  | { kind: 'web'; url: string; pinned: boolean }
  | { kind: 'editor'; filePath: string; pinned: boolean };

export type TabSession = {
  tabs: TabSessionSpec[];
  /** Index into `tabs` of the tab that was active, or -1 (activate the first). */
  activeIndex: number;
};

function sessionFile(): string {
  return path.join(app.getPath('userData'), 'tab-session.json');
}

/** The restorable open tabs in strip order, plus the active tab's index. */
function sessionFromState(): TabSession {
  const tabs: TabSessionSpec[] = [];
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
    if (rec.id === activeId) activeIndex = tabs.length;
    tabs.push(spec);
  }
  return { tabs, activeIndex };
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
  if (o.kind === 'web') return typeof o.url === 'string';
  if (o.kind === 'editor') return typeof o.filePath === 'string';
  return false;
}

/** Read the saved tab session synchronously (startup restore). Empty on any error. */
export function loadTabSession(): TabSession {
  try {
    const parsed: unknown = JSON.parse(readFileSync(sessionFile(), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { tabs: [], activeIndex: -1 };
    const o = parsed as Record<string, unknown>;
    const tabs = Array.isArray(o.tabs) ? o.tabs.filter(isSpec) : [];
    const activeIndex =
      typeof o.activeIndex === 'number' && o.activeIndex >= 0 && o.activeIndex < tabs.length
        ? o.activeIndex
        : -1;
    return { tabs, activeIndex };
  } catch {
    return { tabs: [], activeIndex: -1 };
  }
}
