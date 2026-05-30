import { isPatchOp, type PatchOp } from '../../shared/patch';
import type { ProposeResult, ProposeUsage } from '../../shared/composer';
import type { ProviderId } from '../../shared/providers';

/**
 * Provider-agnostic plumbing for the `propose_patch` tool call: the system
 * prompt, the JSON-Schema tool definition, tool-output validation, and the
 * shared result-shaping tail. Each provider driver formats these for its own API
 * but the contract (and the validation) lives here once.
 */

export const TOOL_NAME = 'propose_patch';
export const MAX_TOKENS = 4096;

/**
 * Raised by a driver's `listModels` when the provider rejects the credential
 * (HTTP 401/403). Distinct from transient/network failures so callers can tell
 * "your key is wrong" apart from "the network hiccuped" — the former should
 * surface to the user (and power the Settings "Test connection" button), the
 * latter should fall back to the static catalog.
 */
export class ProviderAuthError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ProviderAuthError';
    this.status = status;
  }
}

/** True when an HTTP status means the credential was rejected. */
export function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

export const SYSTEM_PROMPT = `You are marudesk, an assistant that proposes edits to a user's local workspace.

You receive:
- A user prompt describing the desired change.
- One or more captures from a live web page (selector, tagName, text, attributes, URL).
- For each capture, a small set of workspace source files ranked by likely relevance.

Your job: emit one and only one tool call to "propose_patch" with a minimal set of file edits that accomplish the user's request.

Rules:
- Only edit files that were provided to you in the user message. Never invent paths.
- Use the exact relative paths as shown ("path" field of each file block).
- For "oldString": copy a UNIQUE contiguous substring from the file's CURRENT content verbatim, including leading whitespace and line breaks. It must appear exactly once.
- For "newString": the replacement substring. Use "" only if you intend a deletion of the matched region.
- To create a new file, set "oldString" to "" and "newString" to the full file contents. Only do this if the requested file truly does not exist.
- Never include explanatory prose in the patch content itself. Prose goes in the "rationale" field.
- Prefer the smallest possible oldString that still uniquely identifies the edit site.
- Do not emit ops you are not confident about. If the request is ambiguous or the files do not match, return an empty ops array and explain in "rationale".`;

export const TOOL_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    rationale: {
      type: 'string',
      description:
        'One short paragraph explaining the approach. No markdown lists, no headings.',
    },
    ops: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Workspace-relative path. Must match a path provided in the user message.',
          },
          oldString: {
            type: 'string',
            description:
              'Exact substring to replace, copied verbatim from current file content. Empty string to create a new file.',
          },
          newString: {
            type: 'string',
            description: 'Replacement substring (or full content for a new file).',
          },
        },
        required: ['path', 'oldString', 'newString'],
        additionalProperties: false,
      },
    },
  },
  required: ['rationale', 'ops'],
  additionalProperties: false,
};

// Gemini's JSON Schema dialect rejects "additionalProperties" and "$schema".
export function geminiSchema(schema: object): object {
  const clone = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  const strip = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(strip);
      return;
    }
    const obj = node as Record<string, unknown>;
    delete obj.additionalProperties;
    delete obj.$schema;
    Object.values(obj).forEach(strip);
  };
  strip(clone);
  return clone;
}

type ToolPayload = { ops: PatchOp[]; rationale: string };

export function validateToolInput(
  input: unknown,
): ToolPayload | { error: string } {
  if (!input || typeof input !== 'object') {
    return { error: 'tool input was not an object' };
  }
  const rec = input as Record<string, unknown>;
  const rationale = typeof rec.rationale === 'string' ? rec.rationale : '';
  const rawOps = rec.ops;
  if (!Array.isArray(rawOps)) {
    return { error: 'tool input "ops" was not an array' };
  }
  const ops: PatchOp[] = [];
  for (let i = 0; i < rawOps.length; i++) {
    if (!isPatchOp(rawOps[i])) {
      return { error: `tool input ops[${i}] missing required fields` };
    }
    const op = rawOps[i] as PatchOp;
    ops.push({
      path: op.path,
      oldString: op.oldString,
      newString: op.newString,
    });
  }
  return { ops, rationale };
}

/**
 * Shared adapter tail: validate the model's raw tool input and shape it into a
 * ProposeResult. Each driver computes the provider-specific `usage` and calls
 * this, so the validation + ok-envelope lives in exactly one place.
 */
export function finishProposal(
  rawInput: unknown,
  provider: ProviderId,
  model: string,
  usage: ProposeUsage,
): ProposeResult {
  const validated = validateToolInput(rawInput);
  if ('error' in validated) {
    return { ok: false, reason: validated.error };
  }
  return {
    ok: true,
    provider,
    model,
    ops: validated.ops,
    rationale: validated.rationale,
    usage,
  };
}

/** "claude-sonnet-4-5-20251022" → "Claude Sonnet 4 5 20251022". */
export function prettifyId(id: string): string {
  return id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
