/**
 * Reusable validators for untrusted IPC payloads. Each throws a terse Error on
 * mismatch (no channel prefix — {@link defineHandler} adds that), so a thrown
 * `'path must be a string'` surfaces to the renderer as
 * `'workspace:rename: path must be a string'`.
 *
 * These are deliberately SHALLOW shape checks. Deep workspace path-safety
 * (traversal, symlink, realpath) lives in fs-safe.ts and must still be applied
 * by the business logic — never assume a validated string is a safe path.
 */

export function str(v: unknown, field = 'value'): string {
  if (typeof v !== 'string') throw new Error(`${field} must be a string`);
  return v;
}

export function nonEmptyStr(v: unknown, field = 'value'): string {
  const s = str(v, field);
  if (s.length === 0) throw new Error(`${field} must not be empty`);
  return s;
}

export function optStr(v: unknown, field = 'value'): string | undefined {
  return v === undefined ? undefined : str(v, field);
}

export function bool(v: unknown, field = 'value'): boolean {
  if (typeof v !== 'boolean') throw new Error(`${field} must be a boolean`);
  return v;
}

export function num(v: unknown, field = 'value'): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${field} must be a finite number`);
  }
  return v;
}

export function obj(v: unknown, field = 'payload'): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`${field} must be an object`);
  }
  return v as Record<string, unknown>;
}

export function arr(v: unknown, field = 'value'): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${field} must be an array`);
  return v;
}

export function arrayOf<T>(
  v: unknown,
  item: (x: unknown, index: number) => T,
  field = 'value',
): T[] {
  return arr(v, field).map((x, i) => item(x, i));
}

export function enumOf<T extends string>(
  v: unknown,
  allowed: readonly T[],
  field = 'value',
): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return v as T;
}
