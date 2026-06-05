/**
 * Canonical email normalization used wherever an address is stored or compared.
 * Accounts are case-insensitive and surrounding whitespace is never significant,
 * so every lookup/registration path must agree on this exact transform.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
