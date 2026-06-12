import { execFile } from 'node:child_process';
import { defineHandler, requireWorkspace } from './ipc/define-handler';
import { bool, obj } from './ipc/validate';
import { parseGitHubRepo } from '../shared/github-url';
import {
  parsePullForBranch,
  summarizeCheckRuns,
  type LaneGithubStatus,
  type LaneGithubStatusResult,
} from '../shared/lane-github';
import { isGitRepo, listWorktrees } from './git-worktree';
import { runGit } from './git';

/**
 * Per-lane GitHub PR/CI status (§3.8 Mission Control). For every non-main
 * worktree branch of the active repo's GitHub `origin`, fetches the branch's PR
 * and the aggregated check-run verdict of its head commit, so the lanes board
 * can show "#123 open · CI failing" without leaving the app.
 *
 * Auth follows the same philosophy as `git:worktree-open-pr` (whatever the
 * environment already has): `GITHUB_TOKEN`/`GH_TOKEN`, else a best-effort
 * `gh auth token`, else unauthenticated (fine for public repos, rate-limited).
 * Results are cached per repo+branch for a short TTL so re-opening the board
 * doesn't burn the rate limit; `force` bypasses the cache.
 */

const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
const MAX_LANES = 20;

const cache = new Map<string, { at: number; status: LaneGithubStatus }>();

/** undefined = not resolved yet; null = no token available (don't retry the CLI). */
let cachedToken: string | null | undefined;

async function githubToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken;
  const env = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (env) {
    cachedToken = env;
    return cachedToken;
  }
  cachedToken = await new Promise<string | null>((resolve) => {
    execFile('gh', ['auth', 'token'], { timeout: 3_000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim() || null);
    });
  }).catch(() => null);
  return cachedToken;
}

async function ghFetch(path: string, token: string | null): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(`https://api.github.com${path}`, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'marudesk',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

/** GitHub reports an exhausted rate limit as 403/429 with a zeroed remaining header. */
function isRateLimited(res: Response): boolean {
  return (
    (res.status === 403 || res.status === 429) &&
    res.headers.get('x-ratelimit-remaining') === '0'
  );
}

async function fetchLaneStatus(
  owner: string,
  repo: string,
  branch: string,
  token: string | null,
): Promise<LaneGithubStatus> {
  try {
    const prRes = await ghFetch(
      `/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=1`,
      token,
    );
    if (isRateLimited(prRes)) return { branch, pr: null, ci: null, error: 'rate-limited' };
    const pr = prRes.ok ? parsePullForBranch(await prRes.json()) : null;
    if (!prRes.ok && prRes.status !== 404) {
      return { branch, pr: null, ci: null, error: 'api-error' };
    }
    // Check runs for exactly the PR's head commit when there is one; otherwise
    // the branch ref (a never-pushed lane 422s here — that's just "no CI").
    const ref = pr?.headSha ?? branch;
    const ciRes = await ghFetch(
      `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
      token,
    );
    if (isRateLimited(ciRes)) return { branch, pr, ci: null, error: 'rate-limited' };
    const ci = ciRes.ok ? summarizeCheckRuns(await ciRes.json()) : null;
    return { branch, pr, ci };
  } catch {
    return { branch, pr: null, ci: null, error: 'api-error' };
  }
}

export function registerLaneGithubHandlers(): void {
  defineHandler('lanes-github:status', async ([payload]): Promise<LaneGithubStatusResult> => {
    const p = obj(payload);
    const force = p.force === undefined ? false : bool(p.force, 'force');
    const root = requireWorkspace().root;
    if (!(await isGitRepo(root))) return { ok: false, reason: 'no-repo' };
    let remoteUrl: string;
    try {
      remoteUrl = (await runGit(root, ['remote', 'get-url', 'origin'])).stdout.trim();
    } catch {
      return { ok: false, reason: 'no-remote' };
    }
    const gh = parseGitHubRepo(remoteUrl);
    if (!gh) return { ok: false, reason: 'not-github' };

    const trees = await listWorktrees(root).catch(() => []);
    const branches = trees
      .filter((wt) => !wt.isMain && wt.branch)
      .slice(0, MAX_LANES)
      .map((wt) => wt.branch as string);

    const token = await githubToken();
    const now = Date.now();
    const statuses = await Promise.all(
      branches.map(async (branch) => {
        const key = `${gh.owner}/${gh.repo}#${branch}`;
        const hit = cache.get(key);
        if (!force && hit && now - hit.at < CACHE_TTL_MS) return hit.status;
        const status = await fetchLaneStatus(gh.owner, gh.repo, branch, token);
        // Don't poison the cache with transient failures — retry those next time.
        if (!status.error) cache.set(key, { at: Date.now(), status });
        return status;
      }),
    );
    return { ok: true, statuses, fetchedAt: Date.now() };
  });
}
