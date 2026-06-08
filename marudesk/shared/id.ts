/**
 * Collision-resistant id helper for persisted records (workflows, specs, …).
 *
 * Shape: `<prefix>-<base36 timestamp>-<base36 random>`. The timestamp keeps ids
 * roughly sortable by creation time; the 6-char random suffix avoids collisions
 * when two are minted in the same millisecond. The body is always `[a-z0-9-]+`,
 * so a generated id matches a `^<prefix>-[a-z0-9-]+$` validator.
 */
export function randomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
