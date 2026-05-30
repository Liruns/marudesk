import type { AgentAnswers, AgentSendInput } from '../../shared/agent';
import type { CapturePayload } from '../../shared/composer';
import { isProviderId } from '../../shared/providers';
import { defineHandler } from '../ipc/define-handler';
import { arr, nonEmptyStr, obj, optStr } from '../ipc/validate';
import { isCapturePayload } from '../llm';
import {
  abortTurn,
  acceptEdit,
  approveTool,
  reset,
  respond,
  revertEdit,
  snapshot,
  startTurn,
} from './loop';

/**
 * IPC surface for the agentic AI Chat. Like every other domain it validates the
 * untrusted renderer payload before touching the loop; the loop itself owns all
 * state and streams it back on the `agent:event` snapshot.
 */

function parseSendInput(payload: unknown): AgentSendInput {
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

function parseAnswers(value: unknown): AgentAnswers {
  const o = obj(value, 'answers');
  const out: AgentAnswers = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

export function registerAgentHandlers(): void {
  defineHandler('agent:send', ([payload]) => startTurn(parseSendInput(payload)));

  defineHandler('agent:abort', ([payload]) => {
    const o = obj(payload);
    return abortTurn(nonEmptyStr(o.turnId, 'turnId'));
  });

  defineHandler('agent:respond', ([payload]) => {
    const o = obj(payload);
    return respond(
      nonEmptyStr(o.turnId, 'turnId'),
      nonEmptyStr(o.callId, 'callId'),
      parseAnswers(o.answers),
    );
  });

  defineHandler('agent:approve-tool', ([payload]) => {
    const o = obj(payload);
    const approved = typeof o.approved === 'boolean' ? o.approved : false;
    return approveTool(
      nonEmptyStr(o.turnId, 'turnId'),
      nonEmptyStr(o.callId, 'callId'),
      approved,
    );
  });

  defineHandler('agent:accept-edit', ([payload]) =>
    acceptEdit(nonEmptyStr(obj(payload).editId, 'editId')),
  );

  defineHandler('agent:revert-edit', ([payload]) =>
    revertEdit(nonEmptyStr(obj(payload).editId, 'editId')),
  );

  defineHandler('agent:snapshot', () => snapshot());

  defineHandler('agent:reset', () => reset());
}
