/**
 * Inline subsequence fuzzy scorer for the quick-open palette — no dependency.
 * Returns a score (higher = better) and the matched character indices for
 * highlighting, or null when the query isn't a subsequence of the candidate.
 *
 * Scoring favors: contiguous runs, matches right after a separator (/ _ - .)
 * or a camelCase boundary, and matches near the basename — the heuristics that
 * make a path search feel like VSCode/fzf without a full algorithm.
 */

export type FuzzyResult = { score: number; positions: number[] };

const SEPARATORS = new Set(['/', '\\', '_', '-', '.', ' ']);

export function fuzzyScore(query: string, target: string): FuzzyResult | null {
  if (query.length === 0) return { score: 0, positions: [] };
  if (query.length > target.length) return null;

  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let qi = 0;
  let prevMatch = -2;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    positions.push(ti);

    // Base point per matched char.
    let pts = 1;
    // Contiguous with the previous match — the strongest signal.
    if (ti === prevMatch + 1) pts += 5;
    // Start of a path segment / word boundary.
    const prevChar = target[ti - 1];
    const isBoundary =
      ti === 0 ||
      (prevChar !== undefined && SEPARATORS.has(prevChar)) ||
      // camelCase: lower→Upper transition.
      (prevChar !== undefined &&
        prevChar === prevChar.toLowerCase() &&
        target[ti] === target[ti].toUpperCase() &&
        target[ti] !== target[ti].toLowerCase());
    if (isBoundary) pts += 3;
    score += pts;

    prevMatch = ti;
    qi++;
  }

  if (qi < q.length) return null; // not all query chars matched

  // Prefer matches concentrated in the basename (after the last slash).
  const slash = target.lastIndexOf('/');
  if (slash >= 0 && positions[0] > slash) score += 4;
  // Mild penalty for a longer target so a tight match floats above a loose one.
  score -= Math.floor(target.length / 40);

  return { score, positions };
}
