import { scrubText } from '../../shared/scrub';
import { clipText } from '../../shared/text-clip';
import { isSafeMcpName, isSafeMcpNamespacedToolName, MAX_MCP_MODEL_TOOL_NAME } from '../../shared/mcp';

const MAX_TOOL_METADATA_TEXT = 1_000;
const MAX_SCHEMA_STRING = 500;
const MAX_SCHEMA_ENTRIES = 100;
const MAX_SCHEMA_ARRAY_ITEMS = 100;
const MAX_SCHEMA_DEPTH = 6;

type JsonObject = Record<string, unknown>;

export type ExternalToolPolicyOptions = {
  readonly trusted?: boolean;
  readonly disabledTools?: readonly string[];
  readonly autoApproveTools?: readonly string[];
  readonly confirmTools?: readonly string[];
};

export type ExternalToolPolicy = {
  readonly trustedAll: boolean;
  readonly hidden: ReadonlySet<string>;
  readonly autoApprove: ReadonlySet<string>;
  readonly confirm: ReadonlySet<string>;
};

export function createExternalToolPolicy(
  options: ExternalToolPolicyOptions,
): ExternalToolPolicy {
  return {
    trustedAll: options.trusted === true,
    hidden: new Set(options.disabledTools ?? []),
    autoApprove: new Set(options.autoApproveTools ?? []),
    confirm: new Set(options.confirmTools ?? []),
  };
}

export function isValidExternalToolName(name: unknown): name is string {
  return typeof name === 'string' && isSafeMcpName(name);
}

export function shouldExposeExternalTool(
  name: unknown,
  policy: ExternalToolPolicy,
  serverId?: string,
): name is string {
  if (!isValidExternalToolName(name)) return false;
  return (
    (serverId === undefined || isSafeMcpNamespacedToolName(serverId, name)) &&
    !policy.hidden.has(name)
  );
}

export function isExternalToolGated(
  name: string,
  policy: ExternalToolPolicy,
): boolean {
  return policy.confirm.has(name) || (!policy.trustedAll && !policy.autoApprove.has(name));
}

export function scrubAndClipCapabilityText(text: string): string {
  return clipText(scrubText(text));
}

export function scrubAndClipToolMetadataText(text: string, max = MAX_TOOL_METADATA_TEXT): string {
  return clipText(scrubText(text), max);
}

export function sanitizeExternalInputSchema(input: unknown): {
  readonly type: 'object';
  readonly properties?: Record<string, object>;
  readonly required?: string[];
} {
  if (!isRecord(input) || input.type !== 'object') {
    return { type: 'object', properties: {} };
  }

  const properties: Record<string, object> = {};
  const rawProperties = isRecord(input.properties) ? input.properties : {};
  for (const [name, value] of Object.entries(rawProperties).slice(0, MAX_SCHEMA_ENTRIES)) {
    if (!isSafeSchemaKey(name)) continue;
    const clean = sanitizeSchemaNode(value, 0);
    if (isRecord(clean)) {
      properties[name] = clean;
    }
  }

  const allowed = new Set(Object.keys(properties));
  const required = Array.isArray(input.required)
    ? uniqueStrings(input.required).filter((name) => allowed.has(name)).slice(0, MAX_SCHEMA_ENTRIES)
    : [];

  return {
    type: 'object',
    ...(Object.keys(properties).length > 0 ? { properties } : { properties: {} }),
    ...(required.length > 0 ? { required } : {}),
  };
}

function sanitizeSchemaNode(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return scrubAndClipToolMetadataText(value, MAX_SCHEMA_STRING);
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_SCHEMA_DEPTH) return [];
    return value.slice(0, MAX_SCHEMA_ARRAY_ITEMS).map((item) => sanitizeSchemaNode(item, depth + 1));
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (depth >= MAX_SCHEMA_DEPTH) {
    return {};
  }
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(value).slice(0, MAX_SCHEMA_ENTRIES)) {
    if (!isSafeSchemaKey(key)) continue;
    const clean = sanitizeSchemaNode(child, depth + 1);
    if (clean !== undefined) {
      out[key] = clean;
    }
  }
  return out;
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeSchemaKey(key: string): boolean {
  return isSafeMcpName(key) && scrubAndClipToolMetadataText(key, MAX_MCP_MODEL_TOOL_NAME) === key;
}

function uniqueStrings(values: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
