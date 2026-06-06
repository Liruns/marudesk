/** Secret-shaped env var names stripped before spawning a workspace command. */
const SENSITIVE_ENV = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD|^ANTHROPIC_)/i;

/**
 * Inherit the parent environment minus secret-shaped vars, so a spawned
 * workspace command (and any subprocess) can't read provider keys/tokens. This
 * is the same inherit-minus-secrets posture as the integrated terminal
 * (electron/terminal.ts), centralized here for the agent's `run_command` and the
 * diagnostics runner. The shell still inherits PATH/HOME/etc. — a real build
 * needs those — so this is defense-in-depth, not an empty env.
 */
export function inheritSafeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && !SENSITIVE_ENV.test(key)) env[key] = value;
  }
  return env;
}
