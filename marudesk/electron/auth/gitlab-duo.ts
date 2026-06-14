/**
 * GitLab Duo direct-access token exchange. A GitLab personal access token (PAT,
 * `api` scope) is NOT used directly against the model proxy — GitLab issues a
 * short-lived *direct access* token (plus required headers) that the AI gateway
 * accepts, and proxies the request on to Anthropic / OpenAI. Faithful port of the
 * reference flow (Yeachan-Heo/gajae-code · packages/ai/src/providers/gitlab-duo.ts):
 * POST the PAT to GitLab, cache the issued token for its lifetime, and let the
 * model layer (electron/agent/model.ts) inject it + the headers per request.
 */

const GITLAB_DIRECT_ACCESS_URL =
  'https://gitlab.com/api/v4/ai/third_party_agents/direct_access';
/** The reference treats issued tokens as good for 25 min; refresh before then. */
const DIRECT_ACCESS_TTL_MS = 25 * 60 * 1000;

/** AI-gateway proxy bases. The SDKs append the dialect path (`/messages`,
 *  `/chat/completions`) to these. */
export const GITLAB_DUO_ANTHROPIC_PROXY = 'https://cloud.gitlab.com/ai/v1/proxy/anthropic/v1';
export const GITLAB_DUO_OPENAI_PROXY = 'https://cloud.gitlab.com/ai/v1/proxy/openai/v1';

export type GitLabDuoDirectAccess = {
  token: string;
  headers: Record<string, string>;
  expiresAt: number;
};

const cache = new Map<string, GitLabDuoDirectAccess>();

/** Exchange a GitLab PAT for a direct-access token, caching it for its lifetime. */
export async function getGitLabDuoDirectAccess(pat: string): Promise<GitLabDuoDirectAccess> {
  const cached = cache.get(pat);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const resp = await fetch(GITLAB_DIRECT_ACCESS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ feature_flags: { DuoAgentPlatformNext: true } }),
  });
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).slice(0, 200);
    if (resp.status === 403) {
      throw new Error(`GitLab Duo access denied — ensure Duo is enabled for this account. ${detail}`);
    }
    throw new Error(`GitLab Duo direct-access exchange failed (HTTP ${resp.status}). ${detail}`);
  }
  const payload = (await resp.json()) as {
    token?: unknown;
    headers?: unknown;
  };
  if (typeof payload.token !== 'string' || !payload.token) {
    throw new Error('GitLab Duo direct-access response missing a token');
  }
  const headers =
    payload.headers && typeof payload.headers === 'object'
      ? (payload.headers as Record<string, string>)
      : {};

  const access: GitLabDuoDirectAccess = {
    token: payload.token,
    headers,
    expiresAt: Date.now() + DIRECT_ACCESS_TTL_MS,
  };
  cache.set(pat, access);
  return access;
}

/** Drop cached tokens (e.g. after a credential change). */
export function clearGitLabDuoDirectAccessCache(): void {
  cache.clear();
}
