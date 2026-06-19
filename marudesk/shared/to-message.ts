/**
 * Coerce an unknown thrown value into a display string. Safe for non-Error
 * throws (where `(err as Error).message` would be `undefined`). Use this for any
 * `catch (err)` whose message is surfaced to the user or a store error field.
 *
 * Lives in `shared/` so the main process, renderer, and tests share one
 * implementation; renderer code may also import the re-export at
 * `src/lib/toMessage.ts`.
 */
import { scrubText } from './scrub';

export function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Like {@link toMessage}, but runs the result through {@link scrubText} so any
 * provider/OAuth error body (which can echo tokens, keys, or PII) is redacted
 * before the string crosses to the renderer. Use this at renderer-facing
 * boundaries; keep {@link toMessage} for main-side logging that wants raw text.
 */
export function toScrubbedMessage(err: unknown): string {
  return scrubText(toMessage(err));
}
