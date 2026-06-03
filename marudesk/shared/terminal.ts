/**
 * IPC payload shapes for the integrated terminal. xterm.js runs in the
 * renderer; the PTY lives in main (electron/terminal.ts). Renderer → main is
 * request/response over `invoke` (create/input/resize/dispose); main → renderer
 * streaming uses the `terminal:data` / `terminal:exit` events.
 *
 * The renderer never chooses a cwd or arbitrary process — only cols/rows and an
 * optional shell *override* (which, like VSCode's setting, is the user's own
 * choice). cwd is decided in main (workspace root, else home).
 */

export type TerminalCreateOptions = {
  cols: number;
  rows: number;
  /** Optional explicit shell. Empty = settings default, else OS default. */
  shell?: string;
};

export type TerminalCreated = {
  id: string;
  /** Resolved shell path the PTY was spawned with (for the surface header). */
  shell: string;
  /** Resolved working directory (workspace root, else home). */
  cwd: string;
};

export type TerminalInput = { id: string; data: string };

export type TerminalResize = { id: string; cols: number; rows: number };

export type TerminalDataEvent = { id: string; data: string };

export type TerminalExitEvent = {
  id: string;
  exitCode: number;
  signal?: number;
};
