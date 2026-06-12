/**
 * Terminal error detection — the integrated-terminal twin of
 * shared/runtime-evidence.ts (browser console errors). Pure (no Electron/node
 * imports), so the detection is unit-testable (terminal-evidence.test.ts) and
 * runs in main against the PTY stream (electron/terminal.ts).
 *
 * A detector instance scans the PTY output stream line by line (ANSI-stripped)
 * for error-shaped output — build failures, test failures, stack traces,
 * generic runtime errors — and coalesces consecutive matching lines into ONE
 * {@link TerminalErrorEvent} with a bounded excerpt (a few lines of leading
 * context + the matched run). Identical excerpts are deduped by hash so a
 * re-printed error doesn't re-fire. Scrubbing is NOT done here (the detector
 * stays pure); the terminal layer scrubs at event intake, mirroring
 * read_terminal's egress scrub.
 */

/** One detected terminal error: headline + bounded excerpt. */
export type TerminalErrorEvent = {
  /** Unique per event (renderer list keys). Not stable across restarts. */
  id: string;
  /** Detection time (ms since epoch). */
  timestamp: number;
  /** The first matched line (trimmed, bounded) — the headline. */
  message: string;
  /** Leading context (≤3 lines) + the coalesced matching run (≤40 lines total). */
  excerpt: string;
  /** Excerpt fingerprint, used for the don't-re-fire dedupe. */
  hash: string;
};

/** Count pushed on the `terminal:error-count` event (id = the PTY session id). */
export type TerminalErrorCountEvent = { id: string; count: number };

// CSI (colors/cursor) + OSC (window-title) escape sequences. The same pattern
// the agent's read_terminal path uses — kept here so the detector and the
// scrollback egress strip identically.
const ANSI_ESCAPE =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Strip ANSI CSI/OSC escape sequences so pattern matching sees plain text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '');
}

/** Max lines kept in one event's excerpt (including leading context). */
export const TERMINAL_EXCERPT_MAX_LINES = 40;
/** Lines of leading context included before the first matched line. */
const CONTEXT_LINES = 3;
/** Recent excerpt hashes remembered for dedupe (FIFO). */
const DEDUPE_MAX = 16;
const MAX_MESSAGE = 500;

/**
 * Lines that OPEN an error event. Grouped by tool family:
 *  - TS / bundler build errors (tsc, vite/esbuild, webpack, rustc-style)
 *  - test failures (jest/vitest FAIL, ✗/✖ marks, mocha "N failing", asserts)
 *  - generic runtime errors (Error:, Uncaught, EADDRINUSE, missing module,
 *    Python tracebacks, Rust/Go panics)
 */
const START_PATTERNS: readonly RegExp[] = [
  // build errors
  /\berror TS\d+:/, // tsc: "src/a.ts(1,2): error TS2304: …"
  /^\s*ERROR in /, // webpack
  /\bBuild failed\b/i, // vite/esbuild: "Build failed with 1 error"
  /✘ \[ERROR\]/, // esbuild
  /^\s*error(?:\[\w+\])?: /, // rustc / cargo / generic lowercase "error: …"
  // test failures
  /^\s*FAIL\b/, // jest / vitest suite line
  /^\s*[✗✖] /, // per-test failure marks
  /\b\d+ failing\b/, // mocha summary
  /\bAssertionError\b/,
  // generic runtime errors
  /\b(?:Uncaught )?[A-Z][A-Za-z0-9]*Error: /, // Error: / TypeError: / ReferenceError: …
  /\bUncaught\b/,
  /\bEADDRINUSE\b/,
  /\bCannot find module\b/,
  /^Traceback \(most recent call last\)/, // python
  /\bpanic(?:ked at|:)/, // rust / go
];

/**
 * Lines that EXTEND an already-open event (stack frames and code-frame
 * decoration that follows the headline).
 */
const CONTINUATION_PATTERNS: readonly RegExp[] = [
  /^\s+at .*:\d+:\d+\)?\s*$/, // JS stack frames: "at fn (file:1:2)"
  /^\s*File ".+", line \d+/, // python stack frames
  /^\s{2,}\S/, // indented detail / code-frame lines
  /^\s*[~^|>]+/, // caret / pipe / "> 10 |" code-frame markers
];

function matchesStart(line: string): boolean {
  return START_PATTERNS.some((re) => re.test(line));
}

function matchesContinuation(line: string): boolean {
  return CONTINUATION_PATTERNS.some((re) => re.test(line));
}

/** FNV-1a 32-bit over the excerpt — cheap, stable dedupe fingerprint. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

let seq = 0;
function eventId(): string {
  return `terr-${Date.now().toString(36)}-${++seq}`;
}

export type TerminalErrorDetector = {
  /**
   * Feed a raw PTY chunk. Complete lines are processed immediately; a trailing
   * partial line is buffered until the next push (or flush). Returns any events
   * that CLOSED during this chunk (an event closes on the first line that
   * neither matches nor continues the error run).
   */
  push(chunk: string): TerminalErrorEvent[];
  /**
   * Close any open event (and process the buffered partial line first). Call
   * after a quiet period so an error that is the LAST output still fires.
   */
  flush(): TerminalErrorEvent[];
};

/** Create a stateful per-terminal detector. See module doc for the contract. */
export function createTerminalErrorDetector(): TerminalErrorDetector {
  let partial = '';
  const context: string[] = [];
  let open: {
    context: string[];
    matched: string[];
    message: string;
    timestamp: number;
  } | null = null;
  const seenOrder: string[] = [];
  const seen = new Set<string>();

  const finalize = (out: TerminalErrorEvent[]): void => {
    if (!open) return;
    const matched = [...open.matched];
    while (matched.length > 0 && matched[matched.length - 1].trim() === '') matched.pop();
    const { context: lead, message, timestamp } = open;
    open = null;
    if (matched.join('').trim() === '') return;
    const excerpt = [...lead, ...matched].join('\n');
    // Hash only the matched run — leading context varies between occurrences
    // of the same error and must not defeat the dedupe.
    const hash = fnv1a(matched.join('\n'));
    if (seen.has(hash)) return; // debounce: same excerpt already fired
    seen.add(hash);
    seenOrder.push(hash);
    if (seenOrder.length > DEDUPE_MAX) {
      const oldest = seenOrder.shift();
      if (oldest !== undefined) seen.delete(oldest);
    }
    out.push({ id: eventId(), timestamp, message, excerpt, hash });
  };

  const processLine = (raw: string, out: TerminalErrorEvent[]): void => {
    const line = stripAnsi(raw);
    if (open) {
      // Coalesce: matching lines, continuation lines, and interior blank lines
      // (build tools blank-line-separate the headline from the code frame)
      // extend the open event. Trailing blanks are trimmed at finalize.
      if (line.trim() === '' || matchesStart(line) || matchesContinuation(line)) {
        if (open.context.length + open.matched.length < TERMINAL_EXCERPT_MAX_LINES) {
          open.matched.push(line);
        }
        return;
      }
      finalize(out);
      // fall through — the closing line becomes future context
    } else if (matchesStart(line)) {
      open = {
        context: [...context],
        matched: [line],
        message: line.trim().slice(0, MAX_MESSAGE),
        timestamp: Date.now(),
      };
      return;
    }
    context.push(line);
    if (context.length > CONTEXT_LINES) context.shift();
  };

  return {
    push(chunk: string): TerminalErrorEvent[] {
      const out: TerminalErrorEvent[] = [];
      const text = partial + chunk;
      const lines = text.split(/\r\n|\r|\n/);
      partial = lines.pop() ?? '';
      for (const line of lines) processLine(line, out);
      return out;
    },
    flush(): TerminalErrorEvent[] {
      const out: TerminalErrorEvent[] = [];
      if (partial) {
        processLine(partial, out);
        partial = '';
      }
      finalize(out);
      return out;
    },
  };
}
