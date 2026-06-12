/**
 * Plain-JSON value model + parser shared by the JsonTree component and its
 * consumers (Network response/frames viewers). Lives outside the component file
 * so JsonTree.tsx exports components only (react-refresh constraint).
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Parse text into a tree-renderable container, or undefined (caller falls back). */
export function parseJsonContainer(text: string): JsonValue | undefined {
  try {
    const value = JSON.parse(text) as JsonValue;
    return typeof value === 'object' && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}
