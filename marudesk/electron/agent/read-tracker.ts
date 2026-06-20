import crypto from 'node:crypto';

/**
 * Edit-staleness guard (absorbed from oh-my-openagent's hashline idea — the
 * single change that lifted its edit success rate from 6.7% to 68.3%). marudesk
 * already rejects a non-unique / not-found `oldString`, so a malformed edit can't
 * land; what it could NOT catch is an edit made against a STALE read — the agent
 * read a file, the file then changed on disk (the user saved it, the terminal
 * rewrote it, an earlier tool edited it), and the agent's `oldString` still
 * happens to match, so it edits content it never actually saw.
 *
 * We close that gap by remembering a content hash per file at read time. When an
 * edit targets a file whose on-disk content no longer matches what the agent last
 * read, the edit is refused with "re-read it first" instead of clobbering the
 * newer content. Keyed by absolute path; process-global and self-correcting (we
 * always compare against the file's current bytes), so it never goes wrong — at
 * worst it asks the agent to re-read.
 */

const readHashes = new Map<string, string>();

/**
 * Per-path line-content snapshot (SECOND-PASS item 5 / gajae file-read-cache.ts +
 * hashline/recovery.ts). Alongside the whole-file SHA above — which only DETECTS
 * staleness — we remember the exact line text the agent saw at read time. When a
 * later edit's anchor goes stale because the file shifted, this lets the matcher
 * re-locate the SAME line content in the current file WITHOUT a model round-trip,
 * but ONLY when the match is exact + unique (see edit-span.relocateAnchorByContent).
 * Conservative by construction: a snapshot can only ever help find content the
 * model actually saw; it never invents an edit target, so edit safety is preserved.
 *
 * Bounded so the cache can't grow without limit across a long session: at most
 * {@link MAX_SNAPSHOT_PATHS} files, and a file larger than {@link MAX_SNAPSHOT_BYTES}
 * is not snapshotted (the SHA staleness guard still applies — it just won't get the
 * zero-retry relocate). The oldest snapshot is evicted (insertion order) at the cap.
 */
const MAX_SNAPSHOT_PATHS = 200;
const MAX_SNAPSHOT_BYTES = 2_000_000;
const lineSnapshots = new Map<string, string[]>();

function hash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Split content into lines with any trailing CR stripped (anchor-equivalent line text). */
function snapshotLines(content: string): string[] {
  return content.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Remember the content the agent just saw for `abs` (called from read_file). */
export function recordRead(abs: string, content: string): void {
  readHashes.set(abs, hash(content));
  recordLineSnapshot(abs, content);
}

/** Store (or refresh) the per-line snapshot for `abs`, enforcing the size + count caps. */
function recordLineSnapshot(abs: string, content: string): void {
  if (content.length > MAX_SNAPSHOT_BYTES) {
    // Too large to snapshot — drop any stale snapshot so we never relocate against
    // out-of-date line text for this path.
    lineSnapshots.delete(abs);
    return;
  }
  // Refresh insertion order so the most-recently-read path is the newest.
  lineSnapshots.delete(abs);
  lineSnapshots.set(abs, snapshotLines(content));
  while (lineSnapshots.size > MAX_SNAPSHOT_PATHS) {
    const oldest = lineSnapshots.keys().next().value;
    if (oldest === undefined) break;
    lineSnapshots.delete(oldest);
  }
}

/**
 * The exact line text the agent saw at 1-based line `lineNo` for `abs` at read
 * time, or undefined when there's no snapshot / the line is out of range. Used by
 * the zero-retry stale-anchor relocate (edit-span.relocateAnchorByContent): the
 * caller takes this remembered line content and finds it uniquely in the CURRENT
 * file. Never falls back to a guess.
 */
export function snapshotLineContent(abs: string, lineNo: number): string | undefined {
  const lines = lineSnapshots.get(abs);
  if (!lines || !Number.isInteger(lineNo) || lineNo < 1 || lineNo > lines.length) return undefined;
  return lines[lineNo - 1];
}

/**
 * Whether `abs` changed since the agent last read it. False when the file was
 * never read (no anchor to compare — the unique-`oldString` check still guards),
 * or when the current content still matches the recorded read.
 */
export function isStaleForEdit(abs: string, currentContent: string): boolean {
  const recorded = readHashes.get(abs);
  return recorded !== undefined && recorded !== hash(currentContent);
}

/** Update the remembered content after a successful edit (so the next edit in the
 * same turn validates against the freshly-written file, not the pre-edit read).
 * Refreshes the line snapshot too so a later same-turn relocate uses post-edit text. */
export function updateAfterWrite(abs: string, newContent: string): void {
  readHashes.set(abs, hash(newContent));
  recordLineSnapshot(abs, newContent);
}

/** Forget every tracked read — called when a conversation is reset/cleared. */
export function clearReadTracker(): void {
  readHashes.clear();
  lineSnapshots.clear();
}
