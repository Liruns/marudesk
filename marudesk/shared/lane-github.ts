/**
 * Per-lane GitHub PR/CI status (docs/runtime-agent-absorption-2026-06.md §3.8
 * Mission Control) — pure types + parsers for the GitHub REST responses the
 * lanes board consumes. The fetching/caching lives in electron/lanes-github.ts;
 * this module is import-free so the parsers are unit-testable and shared-safe.
 */

export type LanePrState = 'open' | 'draft' | 'merged' | 'closed';

/** The lane branch's pull request, as listed by `GET /repos/{o}/{r}/pulls?head=`. */
export type LanePrInfo = {
  number: number;
  title: string;
  /** The PR's web page (html_url) — opened in an in-app browser tab. */
  url: string;
  state: LanePrState;
  /** Head commit sha, used to query check-runs for exactly the PR's commit. */
  headSha: string | null;
};

export type LaneCiState = 'success' | 'failure' | 'pending';

/** Aggregated check-run verdict for the lane's head commit. */
export type LaneCiInfo = {
  state: LaneCiState;
  /** Total check runs seen. */
  total: number;
  /** Runs that concluded failure/cancelled/timed_out/action_required. */
  failed: number;
  /** Web URL of the most relevant run (first failed, else first) for click-through. */
  url: string | null;
};

/** PR + CI status for one lane branch. `error` marks an API-level failure. */
export type LaneGithubStatus = {
  branch: string;
  pr: LanePrInfo | null;
  ci: LaneCiInfo | null;
  error?: 'rate-limited' | 'api-error';
};

export type LaneGithubStatusResult =
  | { ok: true; statuses: LaneGithubStatus[]; fetchedAt: number }
  | { ok: false; reason: 'no-repo' | 'no-remote' | 'not-github' };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse the `GET /pulls?head=owner:branch&state=all` response (an array; the
 * first item is the newest PR for the branch) into {@link LanePrInfo}.
 * Returns null when the branch has no PR or the payload isn't the shape GitHub
 * documents.
 */
export function parsePullForBranch(payload: unknown): LanePrInfo | null {
  if (!Array.isArray(payload) || payload.length === 0) return null;
  const pr = payload[0];
  if (!isRecord(pr)) return null;
  const number = pr['number'];
  const url = pr['html_url'];
  if (typeof number !== 'number' || typeof url !== 'string') return null;
  const title = typeof pr['title'] === 'string' ? pr['title'] : '';
  const merged = typeof pr['merged_at'] === 'string';
  const draft = pr['draft'] === true;
  const open = pr['state'] === 'open';
  const state: LanePrState = merged ? 'merged' : open ? (draft ? 'draft' : 'open') : 'closed';
  const head = isRecord(pr['head']) ? pr['head'] : null;
  const headSha = head && typeof head['sha'] === 'string' ? head['sha'] : null;
  return { number, title, url, state, headSha };
}

/** Conclusions that mean the run did NOT pass (neutral/skipped/success are fine). */
const FAILED_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required']);

/**
 * Aggregate the `GET /commits/{ref}/check-runs` response into one CI verdict:
 * any failed conclusion → `failure`; else any non-completed run → `pending`;
 * else `success`. Returns null when the commit has no check runs at all (the
 * repo runs no CI — not the same as a pending run).
 */
export function summarizeCheckRuns(payload: unknown): LaneCiInfo | null {
  if (!isRecord(payload) || !Array.isArray(payload['check_runs'])) return null;
  const runs = payload['check_runs'].filter(isRecord);
  if (runs.length === 0) return null;
  let failed = 0;
  let pending = 0;
  let failedUrl: string | null = null;
  for (const run of runs) {
    if (run['status'] !== 'completed') {
      pending += 1;
      continue;
    }
    const conclusion = run['conclusion'];
    if (typeof conclusion === 'string' && FAILED_CONCLUSIONS.has(conclusion)) {
      failed += 1;
      if (!failedUrl && typeof run['html_url'] === 'string') failedUrl = run['html_url'];
    }
  }
  const first = runs[0];
  const firstUrl = typeof first['html_url'] === 'string' ? first['html_url'] : null;
  return {
    state: failed > 0 ? 'failure' : pending > 0 ? 'pending' : 'success',
    total: runs.length,
    failed,
    url: failedUrl ?? firstUrl,
  };
}
