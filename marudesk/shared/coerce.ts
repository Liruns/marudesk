/**
 * Generic unknown→typed coercion primitives for validating persisted/over-the-
 * wire data (settings, etc.). Each takes a fallback used when the input is the
 * wrong shape, so a malformed or foreign-version blob degrades to sane defaults
 * instead of throwing. Domain-specific coercers (shells, model chains) live with
 * their schema; these are the reusable building blocks.
 */

/** Treat `value` as a plain object, or `{}` when it isn't one. */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * Narrow `value` to a plain object: a non-null, non-array object. Use this to
 * gate property access on `unknown` without a broad cast — the narrowed type is
 * `Record<string, unknown>`, so member reads stay typed.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrow `value` to a finite number (excludes `NaN`/`±Infinity`). */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Narrow `value` to a string. */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** A finite number rounded and clamped to `[min, max]`, else `fallback`. */
export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Clamp a 0–1 fraction (no rounding, unlike {@link clampNumber}). */
export function clampFraction(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

export function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** One of `allowed`, else `fallback`. */
export function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}
