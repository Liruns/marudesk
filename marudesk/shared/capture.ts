import type { StackFrameLite } from './runtime-evidence';
import { clampNumber, isRecord, isString } from './coerce';

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

/* ── untrusted-payload validation (R4 security) ───────────────────────────── */

/**
 * Upper bounds for the page-derived string fields of an {@link ElementCapture}.
 * A captured page is fully untrusted: it can forge an `inspect:capture` payload
 * with arbitrarily large `text`/`outerHTML` to bloat agent context (or smuggle
 * prompt-injection text). We clamp every string to a sane ceiling before the
 * capture ever reaches the host renderer / agent.
 */
const CAP = {
  /** A CSS selector is short by nature. */
  selector: 2_000,
  /** A tag name is a single token. */
  tagName: 64,
  /** Visible text excerpt (the in-page picker already trims to ~120). */
  text: 4_000,
  /** Attribute key + value caps, and the number of attributes kept. */
  attrKey: 256,
  attrValue: 2_000,
  attrCount: 64,
  /** Serialized markup excerpt. */
  outerHTML: 20_000,
  /** A URL. */
  url: 4_000,
} as const;

/** Truncate a string to `max` chars (no-op when already shorter). */
function clampString(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** A finite rect coordinate clamped to a sane range, else 0. */
function coerceRectField(value: unknown): number {
  return clampNumber(value, 0, -1_000_000, 1_000_000);
}

/**
 * Validate and normalize an untrusted `inspect:capture` payload into a typed
 * {@link ElementCapture}, or `null` when the payload is not a well-formed
 * element capture. Every page-derived string is clamped to a bounded length and
 * the page-supplied `id` is discarded in favor of a fresh host-generated one
 * (`makeId`), so a hostile page cannot forge an id, poison agent context with an
 * oversized payload, or masquerade as another capture kind.
 *
 * Pure: the caller injects `makeId` (the host owns id minting) so this stays
 * importable into main, renderer, and tests without a runtime dependency.
 */
export function coerceElementCapture(raw: unknown, makeId: () => string): ElementCapture | null {
  if (!isRecord(raw)) return null;
  if (raw.kind !== 'element') return null;
  if (!isString(raw.selector) || !isString(raw.tagName)) return null;
  if (!isString(raw.text) || !isString(raw.url)) return null;
  if (!isRecord(raw.rect)) return null;

  const attributes: Record<string, string> = {};
  if (isRecord(raw.attributes)) {
    let kept = 0;
    for (const [key, val] of Object.entries(raw.attributes)) {
      if (kept >= CAP.attrCount) break;
      if (!isString(val)) continue;
      attributes[clampString(key, CAP.attrKey)] = clampString(val, CAP.attrValue);
      kept += 1;
    }
  }

  const capture: ElementCapture = {
    kind: 'element',
    id: makeId(),
    timestamp: Date.now(),
    url: clampString(raw.url, CAP.url),
    selector: clampString(raw.selector, CAP.selector),
    tagName: clampString(raw.tagName, CAP.tagName),
    text: clampString(raw.text, CAP.text),
    attributes,
    rect: {
      x: coerceRectField(raw.rect.x),
      y: coerceRectField(raw.rect.y),
      width: coerceRectField(raw.rect.width),
      height: coerceRectField(raw.rect.height),
    },
  };

  if (isString(raw.outerHTML)) capture.outerHTML = clampString(raw.outerHTML, CAP.outerHTML);

  return capture;
}
