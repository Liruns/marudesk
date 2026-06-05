/**
 * Segment-aware glob → RegExp conversion shared by the agent tools and the
 * plugin permission layer.
 *
 * `*` matches within a single path segment (no `/`), while `**` spans
 * separators. The result is anchored (`^…$`) and case-insensitive, matching the
 * semantics every caller relied on when each kept its own private copy.
 *
 * Note: this is intentionally distinct from `search-core`'s `globToRegExp`,
 * which implements brace expansion, `?`, trailing-slash directory matching and
 * unanchored matching for the workspace search index.
 */
export function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = esc.replace(/\*\*|\*/g, (match) => (match === '**' ? '.*' : '[^/]*'));
  return new RegExp(`^${body}$`, 'i');
}
