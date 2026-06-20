/**
 * Paragraph-level dedup across instruction sources (SECOND-PASS item 7).
 *
 * PURE + dependency-free (no imports), so it loads under a bare
 * `node --experimental-strip-types` harness and is unit-testable in isolation —
 * kept apart from instructions.ts (which pulls node:fs and an extensionless
 * relative import the bare runner can't resolve).
 *
 * WHY: the system prompt concatenates AGENTS.md/CLAUDE.local.md/steering
 * (wsInstructions), the global ~/.claude/CLAUDE.md (globalUserInstructions), and
 * the Settings custom-instruction box — sources that routinely repeat the same
 * paragraph (e.g. a rule pasted into both the global file and AGENTS.md),
 * re-sending it every turn. This removes a later source's paragraph when an
 * earlier source already carried a normalized-identical one (FIRST occurrence
 * wins, so the caller's trust order is preserved).
 */

/**
 * Minimum normalized length for a block to be dedup-eligible. Below this a block
 * is a framing header / separator / one-word line and is ALWAYS kept, so headers
 * like `(AGENTS.md)` or `# Rules` are never collapsed across sources.
 */
const MIN_DEDUP_PARAGRAPH_CHARS = 24;

/**
 * The equality key for a paragraph: whitespace-collapsed + lowercased, used ONLY
 * for comparison. The original text is what survives — never a rewritten form.
 * Returns null when the block is too short to be eligible.
 */
function paragraphKey(block: string): string | null {
  const normalized = block.replace(/\s+/g, ' ').trim().toLowerCase();
  if (normalized.length < MIN_DEDUP_PARAGRAPH_CHARS) return null;
  return normalized;
}

/**
 * Dedup paragraphs across an ordered list of instruction blocks. Returns a new
 * array, same length, with later-source duplicate paragraphs removed; a block
 * that becomes empty is returned as '' (the caller's `.filter()` drops it). Empty
 * inputs pass through untouched, so the no-instructions path is byte-identical.
 */
export function dedupInstructionSources(sources: readonly string[]): string[] {
  const seen = new Set<string>();
  return sources.map((source) => {
    if (!source.trim()) return source;
    const blocks = source.split(/\n{2,}/);
    const kept: string[] = [];
    for (const block of blocks) {
      const key = paragraphKey(block);
      if (key === null) {
        kept.push(block);
        continue;
      }
      if (seen.has(key)) continue; // duplicate of an earlier source — drop it
      seen.add(key);
      kept.push(block);
    }
    return kept.join('\n\n');
  });
}
