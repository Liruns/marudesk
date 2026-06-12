import type { StackFrameLite } from './runtime-evidence';

export type CaptureRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Fields every capture carries, regardless of `kind`. */
type CaptureBase = {
  id: string;
  timestamp: number;
  /** The page URL the capture was taken on (origin used for source mapping). */
  url: string;
  /**
   * An optional note the user attached to this capture (v6 §U2). Sent to the agent
   * as the request when the capture is shared directly ("comment on this element →
   * agent"). The user's own text — the page-derived fields stay untrusted.
   */
  comment?: string;
};

/**
 * An inspected DOM element (the original capture kind — inspect overlay + the
 * DevTools Elements picker). The `kind` discriminator was added for P0; every
 * legacy producer now stamps `kind: 'element'` and the runtime/ranking path is
 * otherwise unchanged.
 */
export type ElementCapture = CaptureBase & {
  kind: 'element';
  selector: string;
  tagName: string;
  text: string;
  attributes: Record<string, string>;
  rect: CaptureRect;
  /**
   * The element's serialized `outerHTML` (bounded). Only the custom DevTools
   * picker populates this — the legacy inspect overlay leaves it undefined — so
   * it stays optional and every consumer must tolerate its absence.
   */
  outerHTML?: string;
  /**
   * A curated subset of the element's computed style (layout/box/typography),
   * keyed by CSS property. Same provenance/optionality as {@link outerHTML}.
   */
  computedStyle?: Record<string, string>;
};

/**
 * A captured runtime console error (P0 "Fix this"). Carries the message, stack
 * frames, and the source location the stack points at — the file resolution is
 * deterministic (stack URL → workspace path) rather than the fuzzy `rankFiles`
 * the element path uses.
 */
export type ConsoleErrorCapture = CaptureBase & {
  kind: 'console-error';
  message: string;
  stack: StackFrameLite[];
  source?: { url: string; lineNumber?: number };
};

/**
 * A detected integrated-terminal error ("terminal error → Fix this"), the
 * terminal twin of {@link ConsoleErrorCapture}. Carries the scrubbed output
 * excerpt plus the PTY identity (terminalId / shell / cwd) so the agent can
 * pull more context via read_terminal. `url` (CaptureBase) is '' — a terminal
 * has no page URL.
 */
export type TerminalErrorCapture = CaptureBase & {
  kind: 'terminal-error';
  /** The headline (first matched line of the detected error). */
  message: string;
  /** Bounded, ANSI-stripped, secret-scrubbed output excerpt. */
  excerpt: string;
  /** The PTY session id (accepted by the agent's read_terminal tool). */
  terminalId: string;
  shell?: string;
  cwd?: string;
};

export type Capture = ElementCapture | ConsoleErrorCapture | TerminalErrorCapture;
