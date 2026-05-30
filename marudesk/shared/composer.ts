import type { PatchOp } from './patch';
import type { ProviderId } from './providers';

export type CapturePayload = {
  id: string;
  tagName: string;
  selector: string;
  text: string;
  attributes: Record<string, string>;
  url: string;
};

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
