import type { PatchOp } from './patch';
import type { ProviderId } from './providers';
import type { StackFrameLite } from './runtime-evidence';

/** Fields every capture payload carries, regardless of `kind`. */
type CapturePayloadBase = {
  id: string;
  url: string;
};

/** An inspected DOM element forwarded to the LLM context (see {@link Capture}). */
export type ElementCapturePayload = CapturePayloadBase & {
  kind: 'element';
  tagName: string;
  selector: string;
  text: string;
  attributes: Record<string, string>;
  /** Optional richer context from the DevTools picker. */
  outerHTML?: string;
  computedStyle?: Record<string, string>;
};

/** A captured runtime console error forwarded to the LLM context (P0). */
export type ConsoleErrorCapturePayload = CapturePayloadBase & {
  kind: 'console-error';
  message: string;
  stack: StackFrameLite[];
  source?: { url: string; lineNumber?: number };
};

export type CapturePayload = ElementCapturePayload | ConsoleErrorCapturePayload;

export type ProposeInput = {
  provider: ProviderId;
  model: string;
  prompt: string;
  captures: CapturePayload[];
};

export type ProposeUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};

export type ProposeOk = {
  ok: true;
  provider: ProviderId;
  model: string;
  ops: PatchOp[];
  rationale: string;
  usage: ProposeUsage;
};

export type ProposeErr = {
  ok: false;
  reason: string;
};

export type ProposeResult = ProposeOk | ProposeErr;

/* ── runtime guards ─────────────────────────────────────────────────────── */

function isStackFrameLite(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.functionName === 'string' &&
    typeof f.url === 'string' &&
    typeof f.lineNumber === 'number' &&
    typeof f.columnNumber === 'number'
  );
}

/**
 * Canonical runtime guard for a {@link CapturePayload}. Lives with the type so
 * the one-shot propose path (electron/llm.ts) and the agent handler
 * (electron/agent/handlers.ts) validate untrusted renderer payloads identically.
 */
export function isCapturePayload(value: unknown): value is CapturePayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id.length === 0) return false;
  if (typeof v.url !== 'string') return false;

  if (v.kind === 'console-error') {
    if (typeof v.message !== 'string') return false;
    if (!Array.isArray(v.stack) || !v.stack.every(isStackFrameLite)) return false;
    if (v.source !== undefined) {
      if (!v.source || typeof v.source !== 'object') return false;
      const s = v.source as Record<string, unknown>;
      if (typeof s.url !== 'string') return false;
      if (s.lineNumber !== undefined && typeof s.lineNumber !== 'number') return false;
    }
    return true;
  }

  if (v.kind === 'element') {
    if (typeof v.tagName !== 'string') return false;
    if (typeof v.selector !== 'string') return false;
    if (typeof v.text !== 'string') return false;
    if (!v.attributes || typeof v.attributes !== 'object') return false;
    for (const val of Object.values(v.attributes as Record<string, unknown>)) {
      if (typeof val !== 'string') return false;
    }
    // Optional richer context from the DevTools picker.
    if (v.outerHTML !== undefined && typeof v.outerHTML !== 'string') return false;
    if (v.computedStyle !== undefined) {
      if (!v.computedStyle || typeof v.computedStyle !== 'object') return false;
      for (const val of Object.values(v.computedStyle as Record<string, unknown>)) {
        if (typeof val !== 'string') return false;
      }
    }
    return true;
  }

  return false; // unknown kind
}
