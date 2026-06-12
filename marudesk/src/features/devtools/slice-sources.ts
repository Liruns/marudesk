import type { StoreApi } from 'zustand';
import { cdpTry } from './cdp';
import type { DebuggerCallFrame, PausedInfo } from './types';
import type { DevtoolsState, DevtoolsActions } from './store';

type DevtoolsStore = DevtoolsState & DevtoolsActions;
type SetState = StoreApi<DevtoolsStore>['setState'];
type GetState = StoreApi<DevtoolsStore>['getState'];

type SourcesActions = Pick<
  DevtoolsActions,
  | 'selectScript'
  | 'openScriptAt'
  | 'revealBreakpoint'
  | 'toggleBreakpoint'
  | 'setPauseOnExceptions'
  | 'pause'
  | 'resume'
  | 'stepOver'
  | 'stepInto'
  | 'stepOut'
  | 'selectCallFrame'
  | '_applySources'
  | '_handlePaused'
  | '_handleResumed'
>;

/**
 * The Sources/Debugger panel actions for the devtools store: script selection +
 * source fetch, url:line breakpoints (set/remove + re-apply on re-attach),
 * pause-on-exceptions, the execution controls (resume/step*), and the pause
 * machine fed by `Debugger.paused`/`Debugger.resumed` (relayed from
 * ingest-batch as effects). Follows the slice-creator pattern of its siblings.
 *
 * While the page is paused, only Debugger/Runtime commands complete — every
 * action here uses exactly those, and nothing in this slice (or in the pause
 * handlers) fires DOM/CSS/Network commands, so the panel stays responsive and
 * other slices aren't deadlocked behind the pause.
 */
export function createSourcesSlice(set: SetState, get: GetState): SourcesActions {
  /** Fire-and-forget a Debugger command against the bound tab. */
  const dbg = (method: string, params?: object) => {
    const tabId = get().tabId;
    if (tabId) void cdpTry(tabId, method, params);
  };

  return {
    selectScript: async (scriptId) => {
      const tabId = get().tabId;
      if (!tabId) return;
      if (get().selectedScriptId === scriptId && get().scriptSource !== null) return;
      set({
        selectedScriptId: scriptId,
        scriptSource: null,
        scriptSourceLoading: true,
        reveal: null,
      });
      const res = await cdpTry<{ scriptSource: string }>(
        tabId,
        'Debugger.getScriptSource',
        { scriptId },
      );
      // Selection moved / session rebound while awaiting — drop the stale source.
      if (get().tabId !== tabId || get().selectedScriptId !== scriptId) return;
      set({ scriptSource: res?.scriptSource ?? null, scriptSourceLoading: false });
    },

    openScriptAt: async (scriptId, lineNumber) => {
      await get().selectScript(scriptId);
      if (get().selectedScriptId !== scriptId) return;
      set((s) => ({ reveal: { line: lineNumber, seq: (s.reveal?.seq ?? 0) + 1 } }));
    },

    revealBreakpoint: async (bp) => {
      // Breakpoints are url-keyed; resolve the current page's script for that
      // URL (after a reload the scriptId differs but the URL matches).
      for (const script of get().scripts.values()) {
        if (script.url === bp.url) {
          await get().openScriptAt(script.scriptId, bp.lineNumber);
          return;
        }
      }
    },

    toggleBreakpoint: async (url, lineNumber) => {
      const tabId = get().tabId;
      if (!tabId || !url) return;
      const existing = get().breakpoints.find(
        (b) => b.url === url && b.lineNumber === lineNumber,
      );
      if (existing) {
        set({
          breakpoints: get().breakpoints.filter((b) => b !== existing),
        });
        if (existing.id) {
          await cdpTry(tabId, 'Debugger.removeBreakpoint', {
            breakpointId: existing.id,
          });
        }
        return;
      }
      const res = await cdpTry<{ breakpointId: string }>(
        tabId,
        'Debugger.setBreakpointByUrl',
        { lineNumber, url, columnNumber: 0 },
      );
      if (!res) return; // command failed — don't record a dead breakpoint
      // Note: re-check for a duplicate in case of a rapid double-click race.
      const dup = get().breakpoints.some(
        (b) => b.url === url && b.lineNumber === lineNumber,
      );
      if (dup) return;
      set({
        breakpoints: [
          ...get().breakpoints,
          { id: res.breakpointId, url, lineNumber },
        ],
      });
    },

    setPauseOnExceptions: (state) => {
      set({ pauseOnExceptions: state });
      dbg('Debugger.setPauseOnExceptions', { state });
    },

    pause: () => dbg('Debugger.pause'),
    resume: () => dbg('Debugger.resume'),
    stepOver: () => dbg('Debugger.stepOver'),
    stepInto: () => dbg('Debugger.stepInto'),
    stepOut: () => dbg('Debugger.stepOut'),

    selectCallFrame: (index) => {
      const paused = get().paused;
      const frame = paused?.callFrames[index];
      if (!paused || !frame) return;
      set({ paused: { ...paused, frameIndex: index } });
      void get().openScriptAt(frame.location.scriptId, frame.location.lineNumber);
    },

    /* ── sticky state re-application (fresh Debugger.enable) ───────────── */

    _applySources: async () => {
      const tabId = get().tabId;
      if (!tabId) return;
      const { pauseOnExceptions, breakpoints } = get();
      if (pauseOnExceptions !== 'none') {
        await cdpTry(tabId, 'Debugger.setPauseOnExceptions', {
          state: pauseOnExceptions,
        });
      }
      // Re-set every url:line breakpoint. On a brand-new session each set
      // succeeds and refreshes the id; after a same-session re-enable the set
      // fails with "already exists" (cdpTry swallows it) and the old id stays
      // valid — both paths converge on a live breakpoint.
      for (const bp of breakpoints) {
        const res = await cdpTry<{ breakpointId: string }>(
          tabId,
          'Debugger.setBreakpointByUrl',
          { lineNumber: bp.lineNumber, url: bp.url, columnNumber: 0 },
        );
        if (get().tabId !== tabId) return;
        if (res) {
          set({
            breakpoints: get().breakpoints.map((b) =>
              b.url === bp.url && b.lineNumber === bp.lineNumber
                ? { ...b, id: res.breakpointId }
                : b,
            ),
          });
        }
      }
    },

    /* ── pause machine (Debugger.paused / Debugger.resumed) ────────────── */

    _handlePaused: (params) => {
      const p = (params ?? {}) as {
        reason?: unknown;
        callFrames?: unknown;
      };
      const callFrames: DebuggerCallFrame[] = Array.isArray(p.callFrames)
        ? (p.callFrames as DebuggerCallFrame[])
        : [];
      const paused: PausedInfo = {
        reason: typeof p.reason === 'string' ? p.reason : 'other',
        callFrames,
        frameIndex: 0,
      };
      set({ paused });
      // Reveal the top frame — Debugger/Runtime commands work while paused.
      const top = callFrames[0];
      if (top) {
        void get().openScriptAt(top.location.scriptId, top.location.lineNumber);
      }
    },

    _handleResumed: () => {
      if (get().paused !== null) set({ paused: null });
    },
  };
}
