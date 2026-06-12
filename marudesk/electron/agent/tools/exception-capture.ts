import { scrubText } from '../../../shared/scrub';
import { clipText as clip } from '../../../shared/text-clip';
import { sendCdp } from '../../browser/cdp';
import type { TabRecord } from '../../browser/state';
import type { ToolContext, ToolResult } from './types';
import { requireTab } from './shared-helpers.ts';

/**
 * Agent exception debugger (arm_exception_capture / read_exception_capture).
 * Arming enables the CDP Debugger domain on the active web tab with
 * pause-on-UNCAUGHT-exceptions; when the page pauses, the main-process handler
 * snapshots the exception description, the top call frames, and the local
 * variables of the topmost frames (bounded object previews via
 * Runtime.getProperties), then IMMEDIATELY resumes and disarms — the page is
 * frozen only for the snapshot. One slot per tab; arming again replaces it.
 *
 * Safety: a forgotten arm can never leave a page pausing forever — the trap
 * auto-expires after {@link ARM_TTL_MS} and on a cross-origin navigation
 * (reload / same-origin keeps it, so reload_and_verify can reproduce load-time
 * crashes), and every teardown path restores setPauseOnExceptions('none'). All CDP methods used here
 * (Debugger.enable/setPauseOnExceptions/resume/disable, Runtime.getProperties)
 * are already admitted by the cdp.ts domain-prefix allowlist.
 */

const ARM_TTL_MS = 120_000;
const MAX_FRAMES = 5;
/** How many topmost frames get their local variables captured. */
const LOCALS_FRAMES = 2;
const MAX_LOCALS_PER_FRAME = 12;
const MAX_LOCAL_VALUE_CHARS = 120;

type CapturedFrame = {
  functionName: string;
  url: string;
  line: number;
  locals: string[];
};

type ExceptionSnapshot = {
  description: string;
  capturedAt: number;
  frames: CapturedFrame[];
};

type Slot = {
  status: 'armed' | 'captured' | 'expired';
  armedAt: number;
  expireReason?: 'timeout' | 'navigation';
  snapshot?: ExceptionSnapshot;
  /** Tears down listeners/timer + restores pause state; present while armed. */
  disarm?: () => void;
};

// Single capture slot per tab. The latest snapshot survives disarm so the agent
// can arm → reproduce → read; re-arming replaces it.
const slots = new Map<string, Slot>();

/* ── CDP payload shapes (only the fields we read; everything else ignored) ── */

type RemoteObject = {
  type?: string;
  className?: string;
  description?: string;
  value?: unknown;
  objectId?: string;
};

type PausedCallFrame = {
  functionName?: string;
  url?: string;
  location?: { lineNumber?: number };
  scopeChain?: { type?: string; object?: { objectId?: string } }[];
};

type PausedParams = {
  reason?: string;
  data?: RemoteObject;
  callFrames?: PausedCallFrame[];
};

/** Render one property's value as a short, JSON-ish preview string. */
function previewValue(v: RemoteObject | undefined): string {
  if (!v) return '(unavailable)';
  const raw =
    v.description ??
    (v.value !== undefined ? JSON.stringify(v.value) : undefined) ??
    v.type ??
    '(unavailable)';
  return raw.length > MAX_LOCAL_VALUE_CHARS ? `${raw.slice(0, MAX_LOCAL_VALUE_CHARS)}…` : raw;
}

/** Read a frame's local-scope variables as bounded `name = preview` strings. */
async function frameLocals(rec: TabRecord, frame: PausedCallFrame): Promise<string[]> {
  const objectId = frame.scopeChain?.find((s) => s?.type === 'local')?.object?.objectId;
  if (!objectId) return [];
  try {
    const res = (await sendCdp(rec, 'Runtime.getProperties', {
      objectId,
      ownProperties: true,
      generatePreview: true,
    })) as { result?: { name?: string; value?: RemoteObject }[] };
    const props = Array.isArray(res?.result) ? res.result : [];
    return props
      .filter((p) => typeof p?.name === 'string')
      .slice(0, MAX_LOCALS_PER_FRAME)
      .map((p) => `${p.name} = ${previewValue(p.value)}`);
  } catch {
    return []; // locals are best-effort — never block the resume on them
  }
}

/** Build the snapshot from a Debugger.paused payload (page is frozen here). */
async function buildSnapshot(rec: TabRecord, params: PausedParams): Promise<ExceptionSnapshot> {
  const data = params.data;
  const description =
    data?.description ?? data?.className ?? (typeof data?.value === 'string' ? data.value : 'uncaught exception');
  const rawFrames = Array.isArray(params.callFrames) ? params.callFrames.slice(0, MAX_FRAMES) : [];
  const frames: CapturedFrame[] = [];
  for (let i = 0; i < rawFrames.length; i++) {
    const f = rawFrames[i];
    frames.push({
      functionName: f.functionName || '(anon)',
      url: f.url ?? '',
      line: (f.location?.lineNumber ?? 0) + 1,
      locals: i < LOCALS_FRAMES ? await frameLocals(rec, f) : [],
    });
  }
  return { description, capturedAt: Date.now(), frames };
}

export async function armExceptionCapture(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const rec = requireTab(ctx);
  if (rec.chromeDevtoolsOpen) {
    return {
      summary: 'arm failed',
      text: 'the built-in Chromium DevTools holds this tab\'s CDP client — close it to arm exception capture',
      isError: true,
    };
  }
  // Re-arming replaces the previous trap (and its snapshot).
  slots.get(rec.id)?.disarm?.();

  await sendCdp(rec, 'Debugger.enable');
  await sendCdp(rec, 'Debugger.setPauseOnExceptions', { state: 'uncaught' });

  const wc = rec.view!.webContents;
  const dbg = wc.debugger;
  const slot: Slot = { status: 'armed', armedAt: Date.now() };
  slots.set(rec.id, slot);

  let capturing = false;
  const teardown = (): void => {
    clearTimeout(timer);
    dbg.removeListener('message', onMessage);
    wc.removeListener('did-navigate', onNavigate);
    slot.disarm = undefined;
    // Restore the page's pause behavior (best-effort — the tab may be gone).
    void sendCdp(rec, 'Debugger.setPauseOnExceptions', { state: 'none' }).catch(() => {});
    void sendCdp(rec, 'Debugger.disable').catch(() => {});
  };
  const expire = (reason: 'timeout' | 'navigation'): void => {
    if (slot.status === 'armed') {
      slot.status = 'expired';
      slot.expireReason = reason;
    }
    teardown();
  };
  // Reproducing via reload_and_verify is part of the documented flow, and CDP
  // pause-on-exceptions persists across same-target navigations — so a reload /
  // same-origin navigation keeps the trap (the TTL is the hard bound). Only
  // navigating AWAY (different origin) disarms, so a forgotten arm never
  // follows the user to another site.
  const armedOrigin = ((): string => {
    try {
      return new URL(wc.getURL()).origin;
    } catch {
      return '';
    }
  })();
  const onNavigate = (_event: Electron.Event, url: string): void => {
    let origin = '';
    try {
      origin = new URL(url).origin;
    } catch {
      // unparseable target — treat as a departure
    }
    if (origin !== armedOrigin) expire('navigation');
  };
  const onMessage = (
    _event: Electron.Event,
    method: string,
    params: unknown,
  ): void => {
    if (method !== 'Debugger.paused' || capturing || slot.status !== 'armed') return;
    const p = (params ?? {}) as PausedParams;
    // Only handle pauses WE caused; anything else (a user breakpoint from the
    // Sources panel) is left to its owner.
    if (p.reason !== 'exception' && p.reason !== 'promiseRejection') return;
    capturing = true;
    void (async () => {
      try {
        slot.snapshot = await buildSnapshot(rec, p);
        slot.status = 'captured';
      } catch {
        // Snapshot failed — keep the slot armed-ish but still resume below.
      } finally {
        await sendCdp(rec, 'Debugger.resume').catch(() => {});
        teardown();
      }
    })();
  };
  const timer = setTimeout(() => expire('timeout'), ARM_TTL_MS);
  dbg.on('message', onMessage);
  wc.on('did-navigate', onNavigate);
  slot.disarm = teardown;

  return {
    summary: 'exception capture armed',
    text: `Armed: the page will pause on its next UNCAUGHT exception, snapshot the error + top ${MAX_FRAMES} frames + locals of the top ${LOCALS_FRAMES} frames, then resume immediately. Auto-disarms after ${ARM_TTL_MS / 1000}s or when the tab leaves the current origin (a reload keeps the trap). Now reproduce the crash (click / fill / press_key / reload_and_verify), then call read_exception_capture.`,
  };
}

function formatSnapshot(s: ExceptionSnapshot): string {
  const lines = [`Exception: ${s.description}`];
  for (const f of s.frames) {
    lines.push(`  at ${f.functionName} ${f.url}:${f.line}`);
    for (const l of f.locals) lines.push(`      ${l}`);
  }
  return lines.join('\n');
}

export async function readExceptionCapture(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const rec = requireTab(ctx);
  const slot = slots.get(rec.id);
  if (!slot) {
    return {
      summary: 'not armed',
      text: 'Exception capture was never armed on this tab — call arm_exception_capture first, then reproduce the crash.',
    };
  }
  if (slot.status === 'armed') {
    const left = Math.max(0, Math.round((slot.armedAt + ARM_TTL_MS - Date.now()) / 1000));
    return {
      summary: 'armed, nothing captured',
      text: `Armed, nothing captured yet (~${left}s before auto-disarm). Reproduce the crash (click / fill / reload_and_verify) and read again.`,
    };
  }
  if (slot.status === 'expired' || !slot.snapshot) {
    const why = slot.expireReason === 'navigation' ? 'the tab navigated' : 'the 120s window elapsed';
    return {
      summary: 'capture expired',
      text: `The trap disarmed without capturing (${why}). Re-arm with arm_exception_capture and reproduce the crash within the window.`,
    };
  }
  return {
    summary: 'exception captured',
    text: clip(scrubText(formatSnapshot(slot.snapshot))),
  };
}
