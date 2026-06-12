import type { AgentChatState } from '../types';

/**
 * Local notifications for PC-owned agent transitions (the thin-client half of
 * the background-agent design's deferred "completion notifications").
 *
 * The phone does NOT compute anything new — it diffs consecutive PC-pushed
 * {@link AgentChatState} snapshots in the transport/store seam and fires a LOCAL
 * notification when, with the app backgrounded:
 *   (a) a background agent task reaches done/error,
 *   (b) a new approval request arrives, or
 *   (c) the main turn finishes (completed/failed).
 *
 * Delivery is feature-detected: Capacitor's `@capacitor/local-notifications`
 * inside the native shell, the Web Notifications API on the web/PWA build, and
 * silently nothing when neither is available. Tapping a notification just opens
 * the app (no deep-link routing). De-duped one-per-transition via edge keys;
 * never fired while the app is foregrounded. The desktop needs no changes — it
 * already streams everything this consumes.
 */

/* ── module state (session-lived; the store syncs the persisted toggle) ───── */

let enabled = false;
let appActive = true;
let lifecycleWired = false;
/** Baseline for transition detection; null until the first snapshot lands. */
let prev: AgentChatState | null = null;
/** Edge keys already notified, so a re-emit can't double-fire. */
const seen = new Set<string>();
const SEEN_CAP = 300;
/** Monotonic int id for LocalNotifications (Android wants a Java int). */
let nextId = Math.floor(Date.now() % 100_000) * 10;

export type AgentNotification = { key: string; title: string; body: string };

function getCapacitor(): {
  isNativePlatform?: () => boolean;
  isPluginAvailable?: (name: string) => boolean;
} | null {
  const cap: unknown = Reflect.get(globalThis, 'Capacitor');
  return cap && typeof cap === 'object' ? cap : null;
}

function isNative(): boolean {
  return Boolean(getCapacitor()?.isNativePlatform?.());
}

function hasLocalNotificationsPlugin(): boolean {
  const isAvailable = getCapacitor()?.isPluginAvailable;
  return typeof isAvailable !== 'function' || isAvailable('LocalNotifications');
}

/* ── lifecycle: foreground/background tracking ────────────────────────────── */

/**
 * Wire the foreground trackers once (call at app boot): `visibilitychange`
 * covers the WebView/PWA, and Capacitor's App `appStateChange` covers the
 * native shell (where the WebView may keep reporting "visible" while paused).
 */
export function initNotificationLifecycle(): void {
  if (lifecycleWired) return;
  lifecycleWired = true;
  appActive = typeof document === 'undefined' || document.visibilityState !== 'hidden';
  try {
    document.addEventListener('visibilitychange', () => {
      appActive = document.visibilityState !== 'hidden';
    });
  } catch {
    // no DOM (tests) — stay foregrounded.
  }
  if (isNative()) {
    void (async () => {
      try {
        const { App } = await import('@capacitor/app');
        void App.addListener('appStateChange', ({ isActive }) => {
          appActive = isActive;
        });
      } catch {
        // @capacitor/app not installed — the visibility listener still covers us.
      }
    })();
  }
}

/** Test hook / explicit override for the foreground flag. */
export function setAppActiveForTesting(active: boolean): void {
  appActive = active;
}

/* ── enable toggle + permission ───────────────────────────────────────────── */

/** Sync the (store-persisted) toggle into this module. */
export function setNotificationsEnabled(value: boolean): void {
  enabled = value;
}

/**
 * Ask the platform for notification permission (called from the settings
 * toggle's user gesture). True when granted. Never throws.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (isNative() && hasLocalNotificationsPlugin()) {
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      const status = await LocalNotifications.requestPermissions();
      return status.display === 'granted';
    } catch {
      return false;
    }
  }
  // Web/PWA dev fallback: the Web Notifications API, feature-detected.
  const N = (globalThis as { Notification?: typeof Notification }).Notification;
  if (!N) return false;
  try {
    if (N.permission === 'granted') return true;
    if (N.permission === 'denied') return false;
    return (await N.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/* ── transition detection (pure — exported for the smoke test) ───────────── */

/**
 * The notification-worthy edges between two consecutive snapshots. Pure and
 * total; each event carries a stable de-dupe key.
 */
export function detectAgentNotifications(
  before: AgentChatState | null,
  after: AgentChatState,
): AgentNotification[] {
  // The first snapshot is a baseline, not a transition — joining a session must
  // not replay notifications for already-pending approvals or finished tasks.
  if (before === null) return [];
  const out: AgentNotification[] = [];

  // (b) a NEW approval request parked the turn.
  const approval = after.pendingApproval;
  if (approval && approval.callId !== before.pendingApproval?.callId) {
    out.push({
      key: `approval:${approval.turnId}:${approval.callId}`,
      title: 'Approval needed',
      body: `The agent wants to run ${approval.name}.`,
    });
  }

  // (c) the main turn finished (running → completed/failed).
  const wasRunning = before.status === 'thinking' || before.status === 'working';
  if (wasRunning && (after.status === 'completed' || after.status === 'failed')) {
    out.push({
      key: `turn:${before.turnId ?? 'unknown'}:${after.status}`,
      title: after.status === 'completed' ? 'Agent finished' : 'Agent failed',
      body:
        after.status === 'completed'
          ? 'The turn completed — open the app to review.'
          : (after.error ?? 'The turn failed — open the app for details.'),
    });
  }

  // (a) a background agent task reached a terminal status.
  const prevTasks = new Map((before.background ?? []).map((t) => [t.id, t]));
  for (const task of after.background ?? []) {
    if (task.status !== 'done' && task.status !== 'error') continue;
    const was = prevTasks.get(task.id);
    if (!was || was.status !== 'running') continue;
    out.push({
      key: `bg:${task.id}:${task.status}`,
      title: task.status === 'done' ? 'Background task finished' : 'Background task failed',
      body:
        task.status === 'done'
          ? `${task.label} completed.`
          : `${task.label}: ${task.error ?? 'failed'}`,
    });
  }
  return out;
}

/* ── presenter ────────────────────────────────────────────────────────────── */

async function present(n: AgentNotification): Promise<void> {
  if (isNative() && hasLocalNotificationsPlugin()) {
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      await LocalNotifications.schedule({
        notifications: [{ id: (nextId = (nextId + 1) % 2_147_483_647), title: n.title, body: n.body }],
      });
      return;
    } catch {
      // fall through to the web API
    }
  }
  const N = (globalThis as { Notification?: typeof Notification }).Notification;
  if (N && N.permission === 'granted') {
    try {
      new N(n.title, { body: n.body, tag: n.key });
    } catch {
      // some WebViews expose the constructor but refuse to fire — ignore.
    }
  }
}

/* ── the transport/store seam ─────────────────────────────────────────────── */

/**
 * Feed every transport state push through here (the store's `wire()` does).
 * Diffs against the previous snapshot, fires at most one notification per
 * transition, and only while the app is backgrounded AND the toggle is on.
 */
export function onAgentState(next: AgentChatState): void {
  const before = prev;
  prev = next;
  const events = detectAgentNotifications(before, next);
  if (events.length === 0) return;
  for (const ev of events) {
    if (seen.has(ev.key)) continue;
    if (seen.size >= SEEN_CAP) seen.clear();
    // Mark foreground transitions as seen too: surfacing them in-app IS the
    // delivery; backgrounding later must not replay them.
    seen.add(ev.key);
    if (!enabled || appActive) continue;
    void present(ev);
  }
}

/** Drop the diff baseline (the store calls this when it swaps transports). */
export function resetNotificationBaseline(): void {
  prev = null;
}
