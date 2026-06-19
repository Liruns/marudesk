import { app } from 'electron';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { atomicWriteFile } from '../fs-safe';
import { tabValues } from './state';
import { displayUrl } from '../../shared/internal-pages';

/**
 * Pinned-tab session persistence. Pinned tabs are the one part of the tab set
 * worth surviving a restart (Chrome/Edge restore pins on launch), so we persist
 * just their specs — a pinned website's URL or a pinned editor's file path — to
 * a small JSON file under userData (trusted, outside any workspace). Transient
 * pins (terminal/agent/settings/home) carry no restorable state and are skipped.
 *
 * Writes are atomic + fire-and-forget (never block a pin toggle or quit); the
 * launch-time restore reads synchronously so pinned tabs exist, in order, before
 * the default home tab is created.
 */

type PinnedSpec =
  | { kind: 'web'; url: string }
  | { kind: 'editor'; filePath: string };

function sessionFile(): string {
  return path.join(app.getPath('userData'), 'pinned-tabs.json');
}

/** The restorable pinned tabs in current strip order (pinned tabs sort first). */
function specsFromState(): PinnedSpec[] {
  const out: PinnedSpec[] = [];
  for (const rec of tabValues()) {
    if (!rec.pinned) continue;
    if (rec.kind === 'web' && rec.view) {
      const url = rec.view.webContents.getURL();
      // displayUrl maps about:blank / maru://newtab → '' and an error page → the
      // URL the user was trying to reach, so a restart retries the real target.
      out.push({ kind: 'web', url: displayUrl(url) });
    } else if (rec.kind === 'editor' && rec.filePath) {
      out.push({ kind: 'editor', filePath: rec.filePath });
    }
  }
  return out;
}

/** Persist the current pinned set (fire-and-forget; never throws to the caller). */
export function savePinnedTabs(): void {
  try {
    void atomicWriteFile(sessionFile(), JSON.stringify(specsFromState()));
  } catch {
    // Best-effort — a failed pin-session write must never break tab operations.
  }
}

function isPinnedSpec(x: unknown): x is PinnedSpec {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (o.kind === 'web') return typeof o.url === 'string';
  if (o.kind === 'editor') return typeof o.filePath === 'string';
  return false;
}

/** Read the saved pinned specs synchronously (startup restore). [] on any error. */
export function loadPinnedSpecs(): PinnedSpec[] {
  try {
    const arr: unknown = JSON.parse(readFileSync(sessionFile(), 'utf8'));
    return Array.isArray(arr) ? arr.filter(isPinnedSpec) : [];
  } catch {
    return [];
  }
}
