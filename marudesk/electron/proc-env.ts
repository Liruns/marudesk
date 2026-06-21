/**
 * Secret-shaped env var names stripped before spawning a workspace command.
 * Single source of truth — also imported by electron/terminal.ts so the
 * integrated terminal and the agent's command/diagnostics runners strip the
 * same set. Inherit-minus-secrets: only credential-looking names match, never
 * PATH/HOME/USER/TEMP/SystemRoot and friends.
 *
 * Matches, case-insensitively:
 *  - any name containing _API_KEY / _ACCESS_KEY_ID / _PRIVATE_KEY / _KEY,
 *    _TOKEN, _SECRET, _PASSWORD / _PASS, _CREDENTIALS / _CREDENTIAL
 *  - names that ARE one of those words on their own (e.g. PASSWORD, TOKEN,
 *    SECRET, CREDENTIALS) via a leading-edge alternative
 *  - the agent's own ANTHROPIC_ vars (its provider) as a whole prefix
 *
 * The credential SUFFIX rules above already cover the real provider secrets
 * (AWS_SECRET_ACCESS_KEY, AWS_ACCESS_KEY_ID, GOOGLE_APPLICATION_CREDENTIALS,
 * GITHUB_TOKEN / GH_TOKEN, OPENAI_API_KEY, AZURE_CLIENT_SECRET, …), so we do NOT
 * strip on a bare provider prefix — that would also eat non-secret config the
 * user's tooling needs (AWS_REGION/AWS_PROFILE, GITHUB_REPOSITORY/WORKSPACE,
 * OPENAI_BASE_URL, GOOGLE_CLOUD_PROJECT) and silently change how `aws`/`gh`/
 * `gcloud` resolve. Deliberately anchored on `_` (or start-of-name) separators
 * so benign names like `KEYBOARD`, `PASSAGE`, `MONKEY`, or `TOKENIZER` do NOT
 * match — only `…_KEY`, `…_PASS`, etc. word-boundaried segments do.
 */
export const SENSITIVE_ENV =
  /(_API_KEY|_ACCESS_KEY_ID|_PRIVATE_KEY|_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS|_CREDENTIALS?|^(?:PASSWORD|PASS|SECRET|TOKEN|API_KEY|PRIVATE_KEY|CREDENTIALS?)$|^ANTHROPIC_)/i;

/** True when an env var name is secret-shaped and must not be inherited. */
export function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV.test(name);
}

/**
 * Copy `source` (defaults to process.env) minus secret-shaped names. Shared so
 * every spawn path strips identically. Only string values are kept, so the
 * result is a plain string→string env safe to hand any spawn API.
 */
export function stripSensitiveEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && !SENSITIVE_ENV.test(key)) env[key] = value;
  }
  return env;
}

/**
 * Inherit the parent environment minus secret-shaped vars, so a spawned
 * workspace command (and any subprocess) can't read provider keys/tokens. This
 * is the same inherit-minus-secrets posture as the integrated terminal
 * (electron/terminal.ts), centralized here for the agent's `run_command` and the
 * diagnostics runner. The shell still inherits PATH/HOME/etc. — a real build
 * needs those — so this is defense-in-depth, not an empty env.
 */
export function inheritSafeEnv(): NodeJS.ProcessEnv {
  return stripSensitiveEnv();
}
