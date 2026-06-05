/**
 * Shared text-clipping helper for agent tool output. Bounds the number of
 * characters handed back to the model and appends a visible marker noting how
 * much was dropped, so large file/console payloads can't blow the context.
 */
export const MAX_TOOL_TEXT = 12_000;

export function clipText(value: string, max = MAX_TOOL_TEXT): string {
  return value.length <= max
    ? value
    : `${value.slice(0, max)}\n…[clipped ${value.length - max} chars]`;
}
