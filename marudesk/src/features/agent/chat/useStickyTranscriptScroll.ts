import { useEffect, useRef, useState } from 'react';
import type { AgentChatState } from '../../../../shared/agent';

const BOTTOM_THRESHOLD_PX = 80;

/* ── transcript windowing (bounded mounted scrollback) ──────────────────────
 * The transcript is NOT virtualized by pixel measurement: `Transcript` doesn't
 * own the scroll container (AgentChat does) and rows are variable-height Markdown
 * / code / tool cards interleaved with non-transcript children, which makes a
 * measured window fragile. Instead we cap how many trailing rows mount so the
 * DOM stops growing unbounded across a long session, with a "Load earlier
 * messages" boundary to reveal the rest. The model's context is already trimmed
 * by /compaction; this only bounds the *visual* scrollback's mounted node count.
 *
 * Sticky auto-scroll is unaffected (it keys off scrollHeight, not row count),
 * and the cap only ever hides the OLDEST rows — never the live edge — so
 * streaming, scroll-up-to-read, turn dividers, ids, and keys all behave as
 * before for recent turns. */

/** Default mounted-tail cap. Long enough that a normal session never hits the
 * boundary; small enough to bound the DOM on a marathon session. */
export const DEFAULT_TRANSCRIPT_WINDOW = 120;

export type TranscriptWindow = {
  /** Start index (inclusive) of the mounted slice within the full row list. */
  readonly start: number;
  /** How many leading rows are hidden behind the "Load earlier" boundary. */
  readonly hiddenCount: number;
};

/**
 * Pure windowing math: given the total row count, a trailing cap, and how many
 * older rows the user has explicitly revealed, compute which rows mount.
 *
 * - The mounted slice is always the TAIL `[start, total)` so the live edge is
 *   never hidden.
 * - `reveal` enlarges the mounted tail (each "Load earlier" click reveals more);
 *   when it reaches `total` everything is mounted and `hiddenCount` is 0.
 * - `forceMin` pins a minimum visible count so a search jump to an old message
 *   can guarantee that row (and everything after it) is mounted.
 */
export function transcriptWindow(
  total: number,
  cap: number,
  reveal: number,
  forceMin = 0,
): TranscriptWindow {
  if (cap <= 0) return { start: 0, hiddenCount: 0 };
  const visible = Math.min(total, Math.max(cap, reveal, forceMin));
  const start = Math.max(0, total - visible);
  return { start, hiddenCount: start };
}

/* ── search-jump coordination ───────────────────────────────────────────────
 * `TranscriptSearch` jumps via getElementById('agent-msg-<id>'), but with the
 * window a target older than the cap isn't mounted. The search sibling can't
 * share React state with `Transcript` without lifting into AgentChat, so they
 * coordinate through this tiny module-level registry: `Transcript` registers an
 * "ensure this message index is mounted" callback, and the search calls it (then
 * waits a frame) before the DOM lookup. */

/** Reveal-by-message-id: returns true if a reveal was triggered (i.e. the
 * message was off-window and the mounted slice was widened). */
type EnsureMounted = (messageId: string) => boolean;
// A SET, not a single slot: more than one AgentChat surface can be live at once
// (the full agent tab + the per-task dock chat), each with its own transcript.
// A single slot would let the last-mounted transcript clobber the others'
// registration (and unmounting one would null a sibling's still-valid control).
const revealFns = new Set<EnsureMounted>();

/**
 * Called by `Transcript` to expose its reveal control to the jump/search callers.
 * Returns an unregister fn; the caller MUST call it on unmount (only its own fn
 * is removed, never a sibling's).
 */
export function registerTranscriptReveal(fn: EnsureMounted): () => void {
  revealFns.add(fn);
  return () => {
    revealFns.delete(fn);
  };
}

/**
 * Ensure the message `messageId` is mounted, then run `then`. Every registered
 * transcript is asked to reveal the id; the one that OWNS the message (it's in
 * that transcript's rows and currently off-window) widens its mounted slice and
 * returns true — the rest are no-ops for ids they don't own. If a reveal fired,
 * `then` runs on the next frame (after React re-renders the wider window);
 * otherwise (already mounted, unknown id, or windowing disabled) it runs now.
 */
export function ensureTranscriptMessageMounted(messageId: string, then: () => void): void {
  let revealed = false;
  for (const fn of revealFns) {
    if (fn(messageId)) revealed = true;
  }
  if (revealed) {
    requestAnimationFrame(then);
    return;
  }
  then();
}

type StickyTranscriptScrollInput = {
  readonly messages: AgentChatState['messages'];
  readonly status: AgentChatState['status'];
  readonly edits: AgentChatState['edits'];
  readonly pendingApproval: AgentChatState['pendingApproval'];
  readonly pendingQuestions: AgentChatState['pendingQuestions'];
  readonly endNote: AgentChatState['endNote'];
};

export function useStickyTranscriptScroll({
  messages,
  status,
  edits,
  pendingApproval,
  pendingQuestions,
  endNote,
}: StickyTranscriptScrollInput) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastScrollTopRef.current = el.scrollTop;
  }, [messages, status, edits, pendingApproval, pendingQuestions, endNote]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;

    const currentTop = el.scrollTop;
    const scrolledUp = currentTop < lastScrollTopRef.current;
    lastScrollTopRef.current = currentTop;

    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX;
    const nextStick = scrolledUp ? false : nearBottom || stickToBottomRef.current;
    stickToBottomRef.current = nextStick;
    setAtBottom(nextStick);
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (e.deltaY >= 0 || !el || el.scrollHeight <= el.clientHeight) return;
    stickToBottomRef.current = false;
    setAtBottom(false);
  };

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const stickToBottom = () => {
    stickToBottomRef.current = true;
  };

  return { scrollRef, atBottom, handleScroll, handleWheel, scrollToBottom, stickToBottom };
}
