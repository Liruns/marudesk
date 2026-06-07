/**
 * Plugin engine-compatibility check (audit H9) — kept electron-free so it can be
 * unit-tested headlessly. Avoids a runtime dependency on the `semver` package:
 * we only need the handful of range forms a plugin manifest realistically uses.
 */

/**
 * Whether `version` satisfies `range`. Supports: "*"/empty (any), exact "1.2.3",
 * ">=1.2.3", caret "^1.2.3" (incl. the 0.x rule — ^0.2.x pins minor, ^0.0.3 pins
 * patch), and tilde "~1.2.3". Anything it can't parse is treated as "no
 * constraint" (allow), so an unusual range never wrongly blocks a plugin.
 */
export function satisfiesEngine(version: string, range: string | undefined): boolean {
  const r = (range ?? '').trim();
  if (!r || r === '*' || r === 'x') return true;
  const v = parseVer(version);
  if (!v) return true;
  const m = r.match(/^(\^|~|>=|)\s*(\d+)\.(\d+)\.(\d+)/);
  if (!m) return true;
  const op = m[1];
  const t: readonly [number, number, number] = [Number(m[2]), Number(m[3]), Number(m[4])];
  const cmp = compareVer(v, t);
  if (op === '') return cmp === 0;
  if (op === '>=') return cmp >= 0;
  if (op === '~') return cmp >= 0 && v[0] === t[0] && v[1] === t[1];
  // caret: compatible within the left-most non-zero segment.
  if (cmp < 0) return false;
  if (t[0] > 0) return v[0] === t[0];
  if (t[1] > 0) return v[0] === 0 && v[1] === t[1];
  return v[0] === 0 && v[1] === 0 && v[2] === t[2];
}

function parseVer(v: string): readonly [number, number, number] | null {
  const m = v.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVer(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
