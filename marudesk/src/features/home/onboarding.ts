/**
 * First-run guide visibility. A tiny localStorage flag so the "What can you do?"
 * guide shows automatically on first launch and stays dismissed afterwards.
 * Bumped suffix (`v1`) lets us re-introduce the guide if it changes materially.
 * All access is guarded — a storage exception must never break the New Tab view.
 */

const SEEN_KEY = 'marudesk.onboarding.guide.v1';

export function hasSeenGuide(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    // No storage (or blocked) — treat as seen so we don't nag on every mount.
    return true;
  }
}

export function markGuideSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // ignore
  }
}
