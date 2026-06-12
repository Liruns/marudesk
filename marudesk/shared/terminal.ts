/**
 * IPC payload shapes for the integrated terminal. xterm.js runs in the
 * renderer; the PTY lives in main (electron/terminal.ts). Renderer → main is
 * request/response over `invoke` (create/input/resize/dispose); main → renderer
 * streaming uses the `terminal:data` / `terminal:exit` events.
 *
 * The renderer never chooses a cwd or arbitrary process — only cols/rows, an
 * optional shell *override* (which, like VSCode's setting, is the user's own
 * choice), and a named PROFILE whose meaning main decides. cwd is decided in
 * main (workspace root, else home).
 */

/**
 * What the PTY runs: the user's shell, or the bundled chat CLI connected to
 * the loopback companion bridge (chat CLI v2 — docs/chat-cli-tui-design.md
 * §6.1). The renderer only ever names a profile; main resolves the command.
 */
export type TerminalProfile = 'shell' | 'agent-cli';

export type TerminalCreateOptions = {
  cols: number;
  rows: number;
  /** Optional explicit shell. Empty = settings default, else OS default. */
  shell?: string;
  /** Which command profile to spawn; absent = 'shell'. */
  profile?: TerminalProfile;
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

/**
 * State of the `marudesk` terminal command — a small shim script on the user's
 * PATH that launches the bundled chat CLI against the running desktop app
 * (electron/cli-command.ts). Surfaced in Settings → Terminal.
 */
export type CliCommandStatus = {
  installed: boolean;
  /** Absolute path of the installed shim, or null when not installed. */
  path: string | null;
  /** Whether the shim's directory is visible on PATH (new terminals count). */
  onPath: boolean;
  /** Human-readable failure reason when an install attempt didn't stick. */
  error?: string;
};
