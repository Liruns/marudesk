import { scrubText } from '../../../shared/scrub';

/**
 * WebSocket / Server-Sent-Events frame capture for the Network panel's Frames
 * tab. Frames arrive over the already-enabled Network domain
 * (`Network.webSocketFrameSent/Received` + `Network.eventSourceMessageReceived`)
 * and are folded into a per-connection ring buffer keyed by requestId — see
 * ingest-batch.ts. Payloads are scrubbed (same policy as request/response
 * bodies) and bounded so a chatty socket can't grow the store unboundedly.
 */

export type WsFrameDirection = 'sent' | 'received';

export type WsFrame = {
  direction: WsFrameDirection;
  /** WebSocket opcode (1 text · 2 binary · 8 close · 9 ping · 10 pong); -1 for SSE. */
  opcode: number;
  /** SSE event name (`eventSourceMessageReceived.eventName`); undefined for WS. */
  eventName?: string;
  /** Scrubbed payload, bounded to {@link MAX_FRAME_PAYLOAD}. Base64 for opcode 2. */
  payload: string;
  truncated: boolean;
  /** Original payload length (chars) before bounding. */
  length: number;
  /** CDP monotonic seconds (comparable to NetworkEntry.startTime). */
  timestamp: number;
};

/** Ring-buffer caps: frames per connection, and tracked connections overall. */
export const MAX_FRAMES_PER_CONNECTION = 500;
export const MAX_FRAME_CONNECTIONS = 50;
const MAX_FRAME_PAYLOAD = 8_000;

function boundPayload(data: string): Pick<WsFrame, 'payload' | 'truncated' | 'length'> {
  const scrubbed = scrubText(data);
  if (scrubbed.length <= MAX_FRAME_PAYLOAD) {
    return { payload: scrubbed, truncated: false, length: data.length };
  }
  return { payload: scrubbed.slice(0, MAX_FRAME_PAYLOAD), truncated: true, length: data.length };
}

export function makeWsFrame(
  direction: WsFrameDirection,
  opcode: number,
  payloadData: string,
  timestamp: number,
): WsFrame {
  return { direction, opcode, timestamp, ...boundPayload(payloadData) };
}

export function makeSseFrame(eventName: string, data: string, timestamp: number): WsFrame {
  return {
    direction: 'received',
    opcode: -1,
    eventName: eventName || 'message',
    timestamp,
    ...boundPayload(data),
  };
}

/** Append to a connection's buffer (caller owns the array), dropping the oldest. */
export function pushFrame(frames: WsFrame[], frame: WsFrame): void {
  frames.push(frame);
  if (frames.length > MAX_FRAMES_PER_CONNECTION) {
    frames.splice(0, frames.length - MAX_FRAMES_PER_CONNECTION);
  }
}

/** Short kind label for a frame row: SSE event name, or the WS opcode's name. */
export function frameKindLabel(frame: WsFrame): string {
  if (frame.eventName !== undefined) return frame.eventName;
  switch (frame.opcode) {
    case 1:
      return 'text';
    case 2:
      return 'binary';
    case 8:
      return 'close';
    case 9:
      return 'ping';
    case 10:
      return 'pong';
    default:
      return `op ${frame.opcode}`;
  }
}

/** True for entries whose detail should show a Frames tab. */
export function isStreamEntry(resourceType: string | undefined): boolean {
  return resourceType === 'WebSocket' || resourceType === 'EventSource';
}
