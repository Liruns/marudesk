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

function hash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Remember the content the agent just saw for `abs` (called from read_file). */
export function recordRead(abs: string, content: string): void {
  readHashes.set(abs, hash(content));
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
 * same turn validates against the freshly-written file, not the pre-edit read). */
export function updateAfterWrite(abs: string, newContent: string): void {
  readHashes.set(abs, hash(newContent));
}

/** Forget every tracked read — called when a conversation is reset/cleared. */
export function clearReadTracker(): void {
  readHashes.clear();
}
