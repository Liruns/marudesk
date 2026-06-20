import type { ModelEntry, ProviderId } from './providers.ts';

/**
 * Model-id normalization for catalog lookups (SECOND-PASS item 2; ref omo
 * `model-normalization.ts`, gajae `model-thinking.ts` canonicalization).
 *
 * PURE + dependency-free beyond a type-only import (erased at runtime), so it
 * loads under a bare `node --experimental-strip-types` harness and is
 * vitest-testable in isolation.
 *
 * WHY: the live `/models` fetch (electron/models.ts) and persisted selections
 * can carry slightly-varied model ids — dotted versions (`claude-opus-4.8` vs
 * the catalog's `claude-opus-4-8`), a vendor prefix (`anthropic/claude-…`,
 * `openai/gpt-5.5`), or a trailing date suffix (`…-20251001`). A bare exact-match
 * `MODELS.find(m => m.id === id)` then returns `undefined`, so the model's
 * `contextWindow` (→ auto-compaction threshold), `reasoning` flag (→ whether the
 * thinking/budget knob is even sent), and `maxOutputTokens` (item 1) silently
 * fall through to defaults. This canonicalizes an id to its catalog form so those
 * lookups resolve for varied ids instead of degrading.
 */

/**
 * Canonicalize a raw model id for catalog matching. CONSERVATIVE — only the
 * transforms that map a real provider/gateway id variant onto its catalog twin:
 *  - drop a leading `vendor/` prefix (OpenRouter-style `anthropic/claude-…`),
 *  - dot→dash inside version segments (`4.8` → `4-8`), the dominant skew between
 *    a live-fetched id and the catalog's dashed id,
 *  - drop a trailing `-YYYYMMDD` date snapshot suffix.
 *
 * It does NOT lowercase, strip arbitrary suffixes, or alter ids that don't match
 * these shapes, so a genuinely distinct id is never collapsed onto a wrong entry.
 */
export function normalizeModelId(id: string): string {
  if (typeof id !== 'string' || id.length === 0) return id;
  let out = id.trim();
  // Drop a single leading `vendor/` prefix (OpenRouter `vendor/model`). Keep any
  // deeper path segments (e.g. `accounts/fireworks/models/…`) by only removing the
  // first segment when it looks like a known vendor namespace.
  const slash = out.indexOf('/');
  if (slash > 0) {
    const head = out.slice(0, slash).toLowerCase();
    if (VENDOR_PREFIXES.has(head)) out = out.slice(slash + 1);
  }
  // Dotted version → dashed (`claude-opus-4.8` → `claude-opus-4-8`,
  // `claude-sonnet-4.6` → `claude-sonnet-4-6`). Only a digit-dot-digit run, so a
  // dotted model family like `gpt-4.1` (a distinct catalog id) is left ALONE —
  // see the guard below.
  const dashed = out.replace(/(\d)\.(\d)/g, '$1-$2');
  // Guard: only adopt the dashed form when the original dotted form is NOT itself
  // a catalog-style id we want to keep. We can't see the catalog here (pure), so
  // the caller's resolver tries the raw id first; this returns a CANDIDATE the
  // resolver falls back to. Returning `dashed` is safe because the resolver only
  // uses it when the raw id missed.
  out = dashed;
  // Drop a trailing `-YYYYMMDD` snapshot (`claude-haiku-4-5-20251001` →
  // `claude-haiku-4-5`). 8 digits at the end after a dash.
  out = out.replace(/-\d{8}$/, '');
  return out;
}

/** Leading path segments treated as a droppable vendor namespace. */
const VENDOR_PREFIXES: ReadonlySet<string> = new Set([
  'anthropic',
  'openai',
  'google',
  'google-vertex',
  'meta',
  'mistralai',
  'mistral',
  'deepseek',
  'deepseek-ai',
  'qwen',
  'x-ai',
  'xai',
  'moonshotai',
  'moonshot',
]);

/**
 * Find a catalog {@link ModelEntry} for a (provider, id) pair, tolerating
 * slightly-varied ids. Tries an exact match first (zero behavior change for the
 * common case), then a normalized match within the same provider, then a
 * normalized match by id alone (a live id whose provider tag drifted). Returns
 * `undefined` only when nothing plausibly matches — callers keep their existing
 * `?? default` fall-throughs.
 */
export function resolveModelEntry(
  models: readonly ModelEntry[],
  // A plain `string` (not just {@link ProviderId}) so call sites holding a
  // loosely-typed `conversationProvider: string` resolve without a cast — the
  // param is only ever compared for equality against a catalog entry's provider.
  provider: ProviderId | string,
  id: string,
): ModelEntry | undefined {
  const exact = models.find((m) => m.provider === provider && m.id === id);
  if (exact) return exact;
  const norm = normalizeModelId(id);
  // Normalized match within the same provider — canonicalizes BOTH sides, so it
  // catches skew in either direction (incoming dotted vs catalog dashed, or the
  // reverse) in one pass.
  const sameProvider = models.find(
    (m) => m.provider === provider && normalizeModelId(m.id) === norm,
  );
  if (sameProvider) return sameProvider;
  // Last resort: a normalized match by id ALONE, for a live id whose provider tag
  // drifted (e.g. an OpenRouter `vendor/model` routed under a compat provider).
  return models.find((m) => normalizeModelId(m.id) === norm);
}
