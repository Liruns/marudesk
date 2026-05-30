/**
 * Coerce an unknown thrown value into a display string. Safe for non-Error
 * throws (where `(err as Error).message` would be `undefined`). Use this for any
 * `catch (err)` whose message is surfaced to the user or a store error field.
 */
export function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
