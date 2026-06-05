/**
 * Normalize an unknown thrown value into a human-readable string. Used wherever
 * a `catch` needs to surface a message to the UI (auth/command errors, transport
 * status detail) without leaking a non-Error object.
 */
export function messageOf(err: unknown, fallback = 'Something went wrong'): string {
  return err instanceof Error ? err.message : fallback;
}
