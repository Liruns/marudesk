/**
 * "Did you mean …?" suggestion for a name lookup miss (skills, and any future
 * name-keyed catalog). The model often calls `skill` with a near-miss — a typo,
 * a different separator, or a fragment of the real name — and a flat "not
 * found" forces a second list round-trip. Pure module: no electron imports, so
 * it stays unit-testable.
 */

/** Plain dynamic-programming Levenshtein distance (catalogs are small: ≤200 short names). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row.push(Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * The catalog name closest to `want`, or null when nothing is plausibly meant.
 * Containment (either direction, 3+ chars) counts as a strong match — "did you
 * mean save-regression-test?" for `regression` — otherwise the edit distance
 * must stay within a budget proportional to the query's length.
 */
export function closestName(want: string, names: readonly string[]): string | null {
  const w = want.trim().toLowerCase();
  if (!w) return null;
  let best: string | null = null;
  let bestScore = Infinity;
  for (const name of names) {
    const n = name.toLowerCase();
    const contains = w.length >= 3 && (n.includes(w) || w.includes(n));
    const score = contains ? 1 : levenshtein(w, n);
    if (score < bestScore) {
      bestScore = score;
      best = name;
    }
  }
  const limit = Math.max(2, Math.floor(w.length / 4));
  return bestScore <= limit ? best : null;
}
