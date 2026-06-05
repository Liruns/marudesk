/**
 * Credential-file guard shared by the agent's read tools and context sources.
 *
 * Reading `.env` / private-key material wholesale would leak secrets that
 * `scrub` can't reliably catch in arbitrary formats, so these files are blocked
 * from agent reads outright. Keeping the pattern in one place ensures the read
 * guard and the grep filter never drift apart.
 */
export const SECRET_FILE_PATTERN =
  /(^|\/)(\.env(\.[\w-]+)?|\.npmrc|\.netrc|\.pgpass|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.pem|.*\.key|.*\.p12|.*\.pfx|credentials(\.json)?)$/i;

/** Whether `filePath` looks like a credential file the agent must not read. */
export function isSecretFile(filePath: string): boolean {
  return SECRET_FILE_PATTERN.test(filePath);
}
