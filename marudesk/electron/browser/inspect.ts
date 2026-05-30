import {
  INSPECT_OVERLAY_SCRIPT,
  INSPECT_OVERLAY_TEARDOWN,
} from '../inspect-overlay';
import { getActive, type TabRecord } from './state';

/**
 * The DOM-inspect overlay (the AI-capture element picker) — distinct from the
 * Chromium DevTools docking in ./devtools. It injects a highlight overlay into
 * the page and tears it down on exit; the inspect-preload (separate partition)
 * reports the picked element back over the inspect:capture/exit channels.
 */

export async function setInspectMode(on: boolean): Promise<void> {
  const active = getActive();
  if (!active || !active.view) return;
  active.inspectOn = on;
  const script = on ? INSPECT_OVERLAY_SCRIPT : INSPECT_OVERLAY_TEARDOWN;
  try {
    await active.view.webContents.executeJavaScript(script, true);
  } catch {
    // Page may be navigating; safe to ignore.
  }
}

/** Re-apply the inspect overlay after the page navigates if inspect is on. */
export function reapplyInspectOverlay(rec: TabRecord): void {
  if (!rec.inspectOn || !rec.view) return;
  rec.view.webContents
    .executeJavaScript(INSPECT_OVERLAY_SCRIPT, true)
    .catch(() => undefined);
}

/** Tear the overlay down for a tab whose page asked to exit inspect mode. */
export async function exitInspect(rec: TabRecord): Promise<void> {
  if (!rec.view) return;
  rec.inspectOn = false;
  await rec.view.webContents
    .executeJavaScript(INSPECT_OVERLAY_TEARDOWN, true)
    .catch(() => undefined);
}
