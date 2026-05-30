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
