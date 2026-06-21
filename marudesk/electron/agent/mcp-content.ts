import { scrubText } from '../../shared/scrub';
import { clipText } from '../../shared/text-clip';
import { wrapUntrustedToolContent } from './tools/fetch-url';
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
 * Whether an external `client.callTool` value is a shape that {@link toToolResult}
 * cannot safely read — i.e. would THROW (or yield nonsense) on field access. The
 * throw risk is specifically a NON-OBJECT: `null` / `undefined` / a string /
 * number, where reading `.content` either throws (null/undefined) or is
 * meaningless. A well-formed object that merely OMITS `content` (a bare `{}`,
 * `{content:"x"}` …) is NOT malformed — the existing code path already degrades
 * those to "(no content)" gracefully, so we leave that behavior untouched and
 * only intercept the genuinely unreadable values. Pure + exported for the harness.
 */
export function isMalformedMcpResult(res: unknown): boolean {
  return res === null || typeof res !== 'object';
}

/**
 * Normalize a malformed external tool result into a SAFE error {@link ToolResult}
 * the loop can fold into the transcript without throwing (SECOND-PASS item 5 /
 * gajae `agent-loop.ts` coerceToolResult). A third-party MCP/plugin that returns
 * `null`, a non-object, or a result missing both `content` and
 * `structuredContent` would otherwise make {@link toToolResult} read `.content`
 * off a non-object and throw MID-LOOP, leaving a half-written transcript (an
 * assistant tool_use with no paired tool_result). Routing it through here yields
 * an `isError` result instead, so the turn stays valid and the model is told the
 * tool misbehaved. Pure + exported for the harness.
 */
export function coerceMalformedMcpResult(name: string): ToolResult {
  return {
    summary: `${name} returned a malformed result`,
    text: `${name} returned a malformed result (no content). The tool did not return a valid MCP response — treat it as failed and try a different approach.`,
    isError: true,
  };
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
 *
 * Boundary guard (SECOND-PASS item 5): a malformed `res` (null / non-object /
 * missing content+structuredContent) is normalized to a safe error result BEFORE
 * any field access, so a misbehaving external server can never throw here and
 * orphan the transcript mid-loop.
 */
export function toToolResult(name: string, res: McpCallToolResult): ToolResult {
  if (isMalformedMcpResult(res)) return coerceMalformedMcpResult(name);
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
  // Frame the third-party payload as untrusted DATA (prompt-injection boundary),
  // applied AFTER scrub+clip so the closing sentinel always survives the cap.
  return {
    summary: name,
    text: wrapUntrustedToolContent(`MCP server ${name}`, scrubText(clipText(text, MAX_TOOL_TEXT))),
    isError: res.isError === true,
  };
}

/** Shape of a `client.getPrompt` result (only the fields we map). */
export type McpGetPromptResult = {
  description?: string;
  messages?: { role?: string; content?: McpContentItem | McpContentItem[] }[];
  [k: string]: unknown;
};

type McpContentItem =
  | { type: 'text'; text: string }
  | { type: string; [k: string]: unknown };

/**
 * Render a `getPrompt` result (a prompt template expanded into chat messages) into a
 * {@link ToolResult} the agent can read. Each message is prefixed with its role; text
 * content is inlined verbatim and non-text content rendered as the same compact note
 * as {@link toToolResult}. Scrubbed + clipped at egress like every external payload.
 */
export function promptToToolResult(name: string, res: McpGetPromptResult): ToolResult {
  const parts: string[] = [];
  if (typeof res.description === 'string' && res.description.trim()) {
    parts.push(res.description.trim());
  }
  for (const msg of Array.isArray(res.messages) ? res.messages : []) {
    const role = typeof msg?.role === 'string' ? msg.role : 'user';
    const blocks = Array.isArray(msg?.content)
      ? msg.content
      : msg?.content
        ? [msg.content]
        : [];
    const rendered = blocks
      .map((item) =>
        item && typeof item.type === 'string' && item.type === 'text' && typeof (item as { text?: unknown }).text === 'string'
          ? (item as { text: string }).text
          : item && typeof item.type === 'string'
            ? describeContentItem(item as { type: string; [k: string]: unknown })
            : '',
      )
      .filter((s) => s.length > 0)
      .join('\n');
    parts.push(`[${role}]\n${rendered}`.trimEnd());
  }
  const text = parts.join('\n\n').trim() || '(no content)';
  return {
    summary: name,
    text: wrapUntrustedToolContent(`MCP server ${name}`, scrubText(clipText(text, MAX_TOOL_TEXT))),
  };
}

/** Shape of a `client.readResource` result (only the fields we map). */
export type McpReadResourceResult = {
  contents?: {
    uri?: string;
    mimeType?: string;
    text?: string;
    blob?: string;
    [k: string]: unknown;
  }[];
  [k: string]: unknown;
};

/**
 * Render a `readResource` result into a {@link ToolResult}. A text resource is
 * inlined under its uri; a binary (`blob`) one is noted with its mime + decoded size
 * but NEVER inlined (same blob policy as {@link toToolResult} — avoids context bloat
 * and a costly secret scan over base64). Scrubbed + clipped at egress.
 */
export function resourceToToolResult(name: string, res: McpReadResourceResult): ToolResult {
  const parts: string[] = [];
  for (const c of Array.isArray(res.contents) ? res.contents : []) {
    const uri = typeof c?.uri === 'string' && c.uri ? c.uri : '?';
    if (typeof c?.text === 'string') {
      parts.push(`[resource ${uri}]\n${c.text}`);
      continue;
    }
    const mime = typeof c?.mimeType === 'string' && c.mimeType ? c.mimeType : undefined;
    const size = base64Bytes(c?.blob);
    parts.push(`[resource ${uri}${mime ? ` (${mime})` : ''}${size ? `, ${humanBytes(size)}` : ''}]`);
  }
  const text = parts.join('\n').trim() || '(no content)';
  return {
    summary: name,
    text: wrapUntrustedToolContent(`MCP server ${name}`, scrubText(clipText(text, MAX_TOOL_TEXT))),
  };
}
