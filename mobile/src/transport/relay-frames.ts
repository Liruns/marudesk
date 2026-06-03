import type { AgentChatState } from '../types';

/**
 * Local, defensive parsers for the relay wire frames the phone receives. These
 * intentionally MIRROR marudesk/shared/remote.ts (`parseRelayHostMessage` + the
 * relay envelope) but are a hand-kept copy — the mobile package must not import
 * across the desktop boundary (AGENTS.md). Keep these in sync with the host:
 * the relay is a dumb pipe that forwards arbitrary peer bytes, so every inbound
 * frame is UNTRUSTED and validated here before it touches the UI.
 */

/** host → client: the authoritative chat state, pushed on every agent:event. */
export type RelayStateEvent = { k: 'event'; state: AgentChatState };

/** host → client: the reply to one client command, correlated by `cid`. */
export type RelayAck = {
  k: 'ack';
  cid: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

/** Everything a host sends to a client (rides inside the relay `payload`). */
export type RelayHostMessage = RelayStateEvent | RelayAck;

/** The relay's control frame, sent once on connect with the current peer counts. */
export type RelayReadyFrame = {
  type: 'ready';
  role: 'host' | 'client';
  accountId: string;
  peers: { hosts: number; clients: number };
};

/** The relay's forwarding envelope wrapping one peer payload. */
export type RelayEnvelopeFrame = {
  type: 'relay';
  from: 'host' | 'client';
  payload: unknown;
};

export type RelayFrame = RelayReadyFrame | RelayEnvelopeFrame;

/** Parse a raw text frame into a known relay frame, or null if malformed/foreign. */
export function parseRelayFrame(raw: unknown): RelayFrame | null {
  if (typeof raw !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const f = value as Record<string, unknown>;
  if (f.type === 'ready') {
    const peers = f.peers as Record<string, unknown> | undefined;
    if (!peers || typeof peers !== 'object') return null;
    const hosts = typeof peers.hosts === 'number' ? peers.hosts : 0;
    const clients = typeof peers.clients === 'number' ? peers.clients : 0;
    return {
      type: 'ready',
      role: f.role === 'host' ? 'host' : 'client',
      accountId: typeof f.accountId === 'string' ? f.accountId : '',
      peers: { hosts, clients },
    };
  }
  if (f.type === 'relay') {
    return { type: 'relay', from: f.from === 'client' ? 'client' : 'host', payload: f.payload };
  }
  return null;
}

/* ── WebRTC signaling (mirror of shared/remote.ts §WebRTC signaling) ─────────
 *
 * The phone negotiates a direct P2P data channel with the PC and runs the same
 * command/event protocol over it; the SDP/ICE exchange rides the relay as these
 * `rtc-*` payloads. The phone is the offerer. Untrusted (relayed) → validated.
 */

/** A serialized ICE candidate (the wire form of RTCIceCandidateInit). */
export type RtcIceCandidate = {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
};

export type RtcOffer = { k: 'rtc-offer'; sid: string; sdp: string };
export type RtcAnswer = { k: 'rtc-answer'; sid: string; sdp: string };
export type RtcIce = { k: 'rtc-ice'; sid: string; candidate: RtcIceCandidate | null };
export type RtcSignal = RtcOffer | RtcAnswer | RtcIce;

function parseIceCandidate(value: unknown): RtcIceCandidate | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  if (typeof c.candidate !== 'string') return null;
  return {
    candidate: c.candidate,
    sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid : null,
    sdpMLineIndex: typeof c.sdpMLineIndex === 'number' ? c.sdpMLineIndex : null,
  };
}

/** Defensively parse a relay payload into an {@link RtcSignal}, or null if it isn't one. */
export function parseRtcSignal(payload: unknown): RtcSignal | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.sid !== 'string' || p.sid.length === 0) return null;
  if (p.k === 'rtc-offer' || p.k === 'rtc-answer') {
    return typeof p.sdp === 'string' && p.sdp.length > 0
      ? { k: p.k, sid: p.sid, sdp: p.sdp }
      : null;
  }
  if (p.k === 'rtc-ice') {
    const candidate = p.candidate === null ? null : parseIceCandidate(p.candidate);
    if (p.candidate !== null && candidate === null) return null;
    return { k: 'rtc-ice', sid: p.sid, candidate };
  }
  return null;
}

/**
 * Defensively parse an inbound host message (the relay envelope's `payload`): an
 * `event` carrying a chat state, or an `ack`. Returns null on anything malformed.
 */
export function parseRelayHostMessage(payload: unknown): RelayHostMessage | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (p.k === 'event') {
    return p.state && typeof p.state === 'object'
      ? { k: 'event', state: p.state as AgentChatState }
      : null;
  }
  if (p.k === 'ack') {
    if (typeof p.cid !== 'string' || typeof p.ok !== 'boolean') return null;
    return {
      k: 'ack',
      cid: p.cid,
      ok: p.ok,
      result: p.result,
      error: typeof p.error === 'string' ? p.error : undefined,
    };
  }
  return null;
}
