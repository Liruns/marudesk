/**
 * Per-lane dev server (docs/runtime-agent-absorption-2026-06.md §3.8 Mission
 * Control) — the lanes board can start the configured dev command
 * (`settings.lanes.devCommand`) inside each worktree's directory, watch its
 * status + detected localhost URL, and open that URL in a browser tab. State is
 * keyed by the worktree path (the lane id) and pushed to the renderer on
 * `lanes:dev-state`.
 */

export type LaneDevStatus = 'starting' | 'running' | 'exited';

export type LaneDevState = {
  /** The worktree directory the dev command runs in (the lane id). */
  path: string;
  status: LaneDevStatus;
  /** Detected `http://localhost:PORT` (or null until one is seen in output). */
  url: string | null;
  /** Process exit code once it has exited, else null. */
  exitCode: number | null;
};

export type LaneDevStartResult =
  | { ok: true }
  | { ok: false; reason: 'no-command' | 'not-a-lane' | 'already-running' };
