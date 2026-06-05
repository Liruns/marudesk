import { scrubText } from '../../shared/scrub';
import { clipText } from '../../shared/text-clip';
import type { ToolResult } from './tools';
import type { McpCallToolResult } from './mcp-external';

/** Bound for an external tool's joined text output (larger than the built-in
 *  tools' limit since MCP servers can return sizable structured payloads). */
const MAX_TOOL_TEXT = 24_000;

/** Human-readable size of a base64 blob's decoded byte length (≈ len * 3/4). */
function base64Bytes(data: unknown): number {
  if (typeof data !== 'string') return 0;
  // Strip padding for a close-enough decoded size — only used for a label.
  const len = data.replace(/=+$/, '').length;
  return Math.floor((len * 3) / 4);
}

/** Format a byte count as a compact label (e.g. `12.3 KB`). */
function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Render ONE non-text content item as a compact, text-only note. We never inline a
 * binary blob (base64 image/audio/resource) into the transcript — it would bloat the
 * context and can't be scanned for secrets cheaply — but we DO surface its type,
 * mime, size, and (for resources/links) the uri/name so the model can act on it
 * (e.g. fetch the resource, or describe the image to the user).
 */
function describeContentItem(item: { type: string; [k: string]: unknown }): string {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  switch (item.type) {
    case 'image':
    case 'audio': {
      const mime = str(item.mimeType) ?? item.type;
      const size = base64Bytes(item.data);
      return `[${item.type} ${mime}${size ? `, ${humanBytes(size)}` : ''}]`;
    }
    case 'resource_link': {
      const uri = str(item.uri) ?? '?';
      const nm = str(item.name);
      const mime = str(item.mimeType);
      return `[resource link${nm ? ` "${nm}"` : ''}: ${uri}${mime ? ` (${mime})` : ''}]`;
    }
    case 'resource': {
      const r = (item.resource && typeof item.resource === 'object'
        ? (item.resource as Record<string, unknown>)
        : {}) as Record<string, unknown>;
      const uri = str(r.uri) ?? '?';
      // An embedded text resource is useful inline; a binary one we just note.
      const inlineText = str(r.text);
      if (inlineText) return `[resource ${uri}]\n${inlineText}`;
      const mime = str(r.mimeType);
      const size = base64Bytes(r.blob);
      return `[resource ${uri}${mime ? ` (${mime})` : ''}${size ? `, ${humanBytes(size)}` : ''}]`;
    }
    default:
      return `[${item.type} content omitted]`;
  }
}

/**
 * Map one `client.callTool` result into marudesk's {@link ToolResult}. MCP returns a
 * content ARRAY (text / image / audio / resource / resource_link); we join the text
 * parts verbatim and render every non-text part as a compact note via
 * {@link describeContentItem} (binary blobs are summarized, never inlined). When a
 * tool returns only `structuredContent` (typed JSON) and no content, we stringify
 * that so the model still sees the payload. Text is scrubbed at egress (a
 * third-party tool may echo secrets). `isError` carries through. Exported for the
 * headless harness.
 */
export function toToolResult(name: string, res: McpCallToolResult): ToolResult {
  const items = Array.isArray(res.content) ? res.content : [];
  const parts: string[] = [];
  for (const item of items) {
    if (!item || typeof item.type !== 'string') continue;
    if (item.type === 'text' && typeof (item as { text?: unknown }).text === 'string') {
      parts.push((item as { text: string }).text);
    } else {
      parts.push(describeContentItem(item as { type: string; [k: string]: unknown }));
    }
  }
  // Fall back to structuredContent when there were no content parts at all.
  if (parts.length === 0 && res.structuredContent !== undefined) {
    try {
      parts.push(JSON.stringify(res.structuredContent));
    } catch {
      // Non-serializable (cycles) — ignore; we'll show "(no content)" below.
    }
  }
  const text = parts.join('\n').trim() || '(no content)';
  return {
    summary: name,
    text: scrubText(clipText(text, MAX_TOOL_TEXT)),
    isError: res.isError === true,
  };
}
