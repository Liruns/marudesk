import type { AgentAnswers, AgentSendInput } from '../../shared/agent';
import { isCapturePayload, type CapturePayload } from '../../shared/composer';
import { isProviderId } from '../../shared/providers';
import { arr, nonEmptyStr, obj, optStr } from '../ipc/validate';

/**
 * Untrusted-payload parsers for the agent loop's public API, shared by BOTH the
 * `agent:*` IPC handlers (electron/agent/handlers.ts) and the headless bridge
 * server (electron/server) so the two entry points validate identically — the
 * server's request bodies are just as untrusted as a renderer's IPC payload, and
 * divergent validation is how a relay quietly drifts from the surface it relays.
 *
 * These are deliberately the same shallow shape checks the rest of the IPC layer
 * uses (electron/ipc/validate.ts); the loop owns all deeper invariants.
 */

/** `agent:send` / `POST /agent/send` body → {@link AgentSendInput}. */
export function parseSendInput(payload: unknown): AgentSendInput {
  const o = obj(payload);
  if (!isProviderId(o.provider)) throw new Error('provider must be a known provider id');
  const captures = arr(o.captures, 'captures');
  if (!captures.every(isCapturePayload)) throw new Error('captures contains an invalid entry');
  return {
    provider: o.provider,
    model: nonEmptyStr(o.model, 'model'),
    prompt: nonEmptyStr(o.prompt, 'prompt'),
    captures: captures as CapturePayload[],
    tabId: optStr(o.tabId, 'tabId'),
  };
}

/** ask_user answers map: keep only string values (drop anything else). */
export function parseAnswers(value: unknown): AgentAnswers {
  const o = obj(value, 'answers');
  const out: AgentAnswers = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** `agent:abort` / `POST /agent/abort` body → the turn id to abort. */
export function parseAbort(payload: unknown): { turnId: string } {
  const o = obj(payload);
  return { turnId: nonEmptyStr(o.turnId, 'turnId') };
}

/** `agent:respond` / `POST /agent/respond` body. */
export function parseRespond(payload: unknown): {
  turnId: string;
  callId: string;
  answers: AgentAnswers;
} {
  const o = obj(payload);
  return {
    turnId: nonEmptyStr(o.turnId, 'turnId'),
    callId: nonEmptyStr(o.callId, 'callId'),
    answers: parseAnswers(o.answers),
  };
}

/** `agent:approve-tool` / `POST /agent/approve` body (missing `approved` → false). */
export function parseApprove(payload: unknown): {
  turnId: string;
  callId: string;
  approved: boolean;
} {
  const o = obj(payload);
  return {
    turnId: nonEmptyStr(o.turnId, 'turnId'),
    callId: nonEmptyStr(o.callId, 'callId'),
    approved: typeof o.approved === 'boolean' ? o.approved : false,
  };
}
