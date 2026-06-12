import type { StackFrameLite } from './runtime-evidence';

/** Fields every capture payload carries, regardless of `kind`. */
type CapturePayloadBase = {
  id: string;
  url: string;
  /** Optional user note forwarded with the capture (v6 §U2). */
  comment?: string;
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

/** A detected integrated-terminal error forwarded to the LLM context. */
export type TerminalErrorCapturePayload = CapturePayloadBase & {
  kind: 'terminal-error';
  message: string;
  excerpt: string;
  terminalId: string;
  shell?: string;
  cwd?: string;
};

export type CapturePayload =
  | ElementCapturePayload
  | ConsoleErrorCapturePayload
  | TerminalErrorCapturePayload;

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
 * the agent handler (electron/agent/handlers.ts) validates untrusted renderer
 * payloads against the same shape the capture producers emit.
 */
export function isCapturePayload(value: unknown): value is CapturePayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id.length === 0) return false;
  if (typeof v.url !== 'string') return false;
  if (v.comment !== undefined && typeof v.comment !== 'string') return false;

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

  if (v.kind === 'terminal-error') {
    if (typeof v.message !== 'string') return false;
    if (typeof v.excerpt !== 'string') return false;
    if (typeof v.terminalId !== 'string' || v.terminalId.length === 0) return false;
    if (v.shell !== undefined && typeof v.shell !== 'string') return false;
    if (v.cwd !== undefined && typeof v.cwd !== 'string') return false;
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
