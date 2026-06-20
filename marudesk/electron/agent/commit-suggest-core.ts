/**
 * Pure map-reduce helpers for the commit/changelog suggester (SECOND-PASS: gajae
 * commit/map-reduce/*, commit/changelog/*). Factored out of commit-suggest.ts so
 * they stay dependency-free (no `ai` / git / Electron) and can be unit-tested in
 * the plain-node commit-suggest harness. The orchestrator wires these into the
 * per-file map calls and the single reduce call.
 *
 * "Map-reduce" here is bounded on purpose: a giant diff would blow the context
 * window and the bill, so we cap the number of files mapped and the bytes per
 * file, and tell the model when we truncated.
 */

/** A conventional-commit type — the standard set the reduce prompt asks the model to choose from. */
export const COMMIT_TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
] as const;
export type CommitType = (typeof COMMIT_TYPES)[number];

/** Max files mapped (each costs one model call) — keeps the map phase bounded. */
export const MAX_MAPPED_FILES = 20;
/** Max bytes of one file's diff fed to its map call — a single huge file can't dominate. */
export const MAX_FILE_DIFF_CHARS = 8_000;

/** One file's slice of a unified `git diff`, split out for an independent map call. */
export type FileDiff = {
  /** The file path (new path for a rename, the path for add/modify/delete). */
  path: string;
  /** The raw `diff --git …` hunk text for this file (possibly truncated). */
  diff: string;
  /** True when this file's diff was clipped to {@link MAX_FILE_DIFF_CHARS}. */
  truncated: boolean;
};

/**
 * Split a unified `git diff` into per-file chunks at each `diff --git` boundary.
 * Pure + tolerant: a path is read from the `diff --git a/… b/…` header (falling
 * back to a `+++ b/…` line for odd headers), and each chunk's body is clipped to
 * {@link MAX_FILE_DIFF_CHARS} so one giant file can't dominate the map phase.
 * Returns [] for an empty/whitespace diff.
 */
export function splitDiffByFile(diff: string): FileDiff[] {
  const trimmed = diff.trim();
  if (!trimmed) return [];
  // Split on the start-of-line "diff --git" marker, keeping each header with its body.
  const parts = trimmed.split(/(?=^diff --git )/m).map((p) => p.trim()).filter(Boolean);
  const out: FileDiff[] = [];
  for (const part of parts) {
    const path = pathFromChunk(part);
    if (!path) continue;
    const truncated = part.length > MAX_FILE_DIFF_CHARS;
    out.push({
      path,
      diff: truncated ? `${part.slice(0, MAX_FILE_DIFF_CHARS)}\n… (diff truncated)` : part,
      truncated,
    });
  }
  return out;
}

/** Read the file path from one `diff --git` chunk (b/-path preferred). */
function pathFromChunk(chunk: string): string | null {
  const git = /^diff --git a\/(.+?) b\/(.+?)\s*$/m.exec(chunk);
  if (git) return git[2].trim();
  const plus = /^\+\+\+ b\/(.+?)\s*$/m.exec(chunk);
  if (plus && plus[1] !== '/dev/null') return plus[1].trim();
  const minus = /^--- a\/(.+?)\s*$/m.exec(chunk);
  if (minus && minus[1] !== '/dev/null') return minus[1].trim();
  return null;
}

/**
 * Apply the file cap to a split diff: keep the first {@link MAX_MAPPED_FILES} files
 * for mapping and report how many were dropped, so the reduce prompt can note the
 * commit covers more files than were individually analyzed. Pure.
 */
export function capMappedFiles(files: FileDiff[]): { mapped: FileDiff[]; omitted: number } {
  if (files.length <= MAX_MAPPED_FILES) return { mapped: files, omitted: 0 };
  return { mapped: files.slice(0, MAX_MAPPED_FILES), omitted: files.length - MAX_MAPPED_FILES };
}

/** The map-phase prompt for ONE file: summarize what changed in it, tersely. */
export function buildMapPrompt(file: FileDiff): string {
  return (
    `Summarize, in ONE terse sentence, what changed in this file and why (the intent, not a line-by-line recap). ` +
    `File: \`${file.path}\`.\n\n\`\`\`diff\n${file.diff}\n\`\`\`\n\nOutput only the one-sentence summary.`
  );
}

/** One file's map result: its path paired with the model's one-line summary. */
export type FileSummary = { path: string; summary: string };

/**
 * The reduce-phase prompt: fold the per-file summaries into a single structured
 * conventional-commit message + changelog entry, returned as strict JSON so the
 * orchestrator can parse it deterministically. Pure. `omitted` (files past the
 * cap) is surfaced so the model knows the change is broader than the listed files.
 */
export function buildReducePrompt(summaries: FileSummary[], omitted: number): string {
  const list = summaries.map((s) => `- \`${s.path}\`: ${s.summary}`).join('\n');
  const omittedNote =
    omitted > 0
      ? `\n\n(${omitted} additional file(s) changed but were not individually summarized — account for them as "and related files".)`
      : '';
  return (
    `You are writing a git commit message for a set of changes, given a one-line summary of each changed file:\n\n` +
    `${list}${omittedNote}\n\n` +
    `Produce a Conventional Commits message and a one-line changelog entry. Reply with ONLY a JSON object of this exact shape:\n` +
    `{\n` +
    `  "type": one of ${COMMIT_TYPES.join('|')},\n` +
    `  "scope": short scope or null (e.g. "agent", "export"),\n` +
    `  "subject": imperative, lower-case, no trailing period, <= 72 chars,\n` +
    `  "body": 1-3 short sentences of context, or null,\n` +
    `  "changelog": one user-facing bullet for a CHANGELOG (no leading dash)\n` +
    `}\n` +
    `Choose the type that best fits the dominant change. Output only the JSON.`
  );
}

/** The structured suggestion the reduce step yields (and the tool returns). */
export type CommitSuggestion = {
  type: CommitType;
  scope: string | null;
  subject: string;
  body: string | null;
  changelog: string;
  /** The assembled `type(scope): subject` header line + body — ready to commit. */
  message: string;
};

/**
 * Parse + validate the reduce step's JSON into a {@link CommitSuggestion}, given a
 * parser for the first JSON object in free text (the orchestrator passes
 * run-task's `firstJsonObject` so this module stays dependency-free). Pure:
 * normalizes the type to the allowed set (defaulting to `chore`), trims the
 * subject, strips a trailing period, and assembles the final `message`. Returns
 * null only when there's no subject to commit.
 */
export function parseCommitSuggestion(
  raw: Record<string, unknown> | null,
): CommitSuggestion | null {
  if (!raw) return null;
  const type = normalizeType(raw.type);
  const scope = typeof raw.scope === 'string' && raw.scope.trim() ? raw.scope.trim() : null;
  const subject = typeof raw.subject === 'string' ? raw.subject.trim().replace(/\.$/, '') : '';
  if (!subject) return null;
  const body = typeof raw.body === 'string' && raw.body.trim() ? raw.body.trim() : null;
  const changelog =
    typeof raw.changelog === 'string' && raw.changelog.trim()
      ? raw.changelog.trim().replace(/^[-*]\s*/, '')
      : subject;
  const header = scope ? `${type}(${scope}): ${subject}` : `${type}: ${subject}`;
  const message = body ? `${header}\n\n${body}` : header;
  return { type, scope, subject, body, changelog, message };
}

/** Coerce an arbitrary value to a known commit type, defaulting to `chore`. */
function normalizeType(value: unknown): CommitType {
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    const match = COMMIT_TYPES.find((t) => t === lower);
    if (match) return match;
  }
  return 'chore';
}

/** Render the suggestion as the model-facing tool result text. */
export function formatSuggestionText(s: CommitSuggestion): string {
  return (
    `Suggested commit message:\n\n${s.message}\n\n` +
    `Changelog entry:\n- ${s.changelog}\n\n` +
    `(Generated by analyzing the diff per-file and reducing to a Conventional Commits message — review before committing.)`
  );
}
