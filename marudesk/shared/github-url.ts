/**
 * Pure helpers to turn a git `origin` remote into a GitHub web URL — used by the
 * lanes board's per-lane "Open PR" (§3.8): push the lane branch, then open the
 * compare/create-PR page. Handles SSH (`git@github.com:owner/repo.git`) and
 * HTTPS (`https://github.com/owner/repo(.git)`) remotes. Non-GitHub remotes
 * return null (the caller surfaces "not a GitHub remote").
 */
export function parseGitHubRepo(remoteUrl: string): { owner: string; repo: string } | null {
  const m = remoteUrl.trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

export function buildCompareUrl(remoteUrl: string, base: string, branch: string): string | null {
  const r = parseGitHubRepo(remoteUrl);
  if (!r) return null;
  return `https://github.com/${r.owner}/${r.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`;
}
