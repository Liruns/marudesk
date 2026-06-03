// The PC's WebRTC ANSWERER (docs/webrtc-p2p-design.md). The phone offers a direct
// RTCDataChannel; once it's open we run the SAME RelayCommand/RelayHostMessage
// protocol over it as the relay path, dispatched through the shared ./dispatch.ts
// (so the L-1 self-approval guard and all validation are reused verbatim — a P2P
// peer is exactly as untrusted as a relayed one). The only thing that rides the
// relay is the SDP/ICE handshake; the resulting data channel bypasses it.
//
// werift is a PURE-TS WebRTC stack — no native build — so it runs in the Electron
// main process right next to the agent loop and relay-client, keeping every remote
// command on the single validated main-process choke point (no renderer ingress).
import { RTCPeerConnection } from 'werift';
import type { RTCDataChannel, RTCIceCandidate } from 'werift';
import type { AgentChatState } from '../../shared/agent';
import {
  parseRelayCommand,
  type RelayAck,
  type RelayStateEvent,
  type RtcIceCandidate,
  type RtcSignal,
} from '../../shared/remote';
import { dispatchAgentCommand, type AgentApi, type ApprovalGuard } from './dispatch';

/** Free public STUN for hole-punching. No traffic flows through it — discovery only. */
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
/** Cap concurrent P2P sessions so a same-account peer can't exhaust main's resources. */
const MAX_SESSIONS = 4;
/** Skip forwarding a state event if the channel is saturated (backpressure). */
const MAX_BUFFERED_BYTES = 1 << 20; // 1 MiB

export type WebrtcHostDeps = {
  /** The agent loop's public API (same instance the relay path dispatches into). */
  agent: AgentApi;
  /** Subscribe to the loop's authoritative state stream; returns an unsubscribe fn. */
  subscribe: (cb: (state: AgentChatState) => void) => () => void;
  /** Send a signaling message back to the phone (over the relay). */
  sendSignal: (signal: RtcSignal) => void;
  /** T2 L-1: refuse a remote self-approval of a gated tool while the bridge is exposed. */
  approvalGuard?: ApprovalGuard;
  /** Notified when the number of OPEN P2P data channels changes (drives status). */
  onSessionsChange?: (open: number) => void;
  /** ICE servers override (defaults to public STUN). `[]` forces loopback-only — used by the harness. */
  iceServers?: { urls: string }[];
};

export type WebrtcHost = {
  /** Feed one inbound signaling message (offer / ice) from a phone. */
  handleSignal(signal: RtcSignal): void;
  /** How many data channels are currently open (P2P active). */
  openSessions(): number;
  /** Close every peer + channel and stop. Idempotent. */
  stop(): void;
};

type Session = {
  sid: string;
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
  /** Agent-event subscription, live only while the channel is open. */
  unsubscribe: (() => void) | null;
  open: boolean;
};

/** Start the WebRTC host. Cheap until a phone actually offers — peers are per-attempt. */
export function startWebrtcHost(deps: WebrtcHostDeps): WebrtcHost {
  const sessions = new Map<string, Session>();
  const iceServers = deps.iceServers ?? ICE_SERVERS;
  let stopped = false;

  function openCount(): number {
    let n = 0;
    for (const s of sessions.values()) if (s.open) n += 1;
    return n;
  }

  function notify(): void {
    deps.onSessionsChange?.(openCount());
  }

  function teardown(s: Session): void {
    if (s.unsubscribe) {
      s.unsubscribe();
      s.unsubscribe = null;
    }
    const wasOpen = s.open;
    s.open = false;
    sessions.delete(s.sid);
    void s.pc.close().catch(() => {
      /* already closing */
    });
    if (wasOpen) notify();
  }

  /** Send a host→peer message over this session's data channel (with backpressure). */
  function sendOnChannel(s: Session, message: RelayStateEvent | RelayAck): void {
    const ch = s.channel;
    if (!ch || ch.readyState !== 'open') return;
    if (ch.bufferedAmount > MAX_BUFFERED_BYTES) return; // saturated peer: skip this snapshot
    try {
      ch.send(JSON.stringify(message));
    } catch {
      // A send race against a closing channel; the connection-state handler recovers.
    }
  }

  function wireChannel(s: Session, channel: RTCDataChannel): void {
    s.channel = channel;

    channel.stateChanged.subscribe((state) => {
      if (state === 'open') {
        s.open = true;
        // Push the current snapshot immediately, then forward every subsequent
        // state — mirroring the relay-client path so the phone repaints at once.
        sendOnChannel(s, { k: 'event', state: deps.agent.snapshot() });
        s.unsubscribe = deps.subscribe((state) => sendOnChannel(s, { k: 'event', state }));
        notify();
      } else if (state === 'closed' || state === 'closing') {
        teardown(s);
      }
    });

    channel.onMessage.subscribe((data) => {
      void handleChannelMessage(s, data);
    });
  }

  /** A peer's data-channel message: validate → dispatch → ack (same as the relay path). */
  async function handleChannelMessage(s: Session, data: string | Buffer): Promise<void> {
    const raw = typeof data === 'string' ? data : data.toString('utf8');
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    const command = parseRelayCommand(payload);
    if (!command) return; // untrusted/malformed peer payload — drop silently
    const outcome = await dispatchAgentCommand(deps.agent, command.cmd, command.args, deps.approvalGuard);
    const ack: RelayAck = outcome.ok
      ? { k: 'ack', cid: command.cid, ok: true, result: outcome.result }
      : { k: 'ack', cid: command.cid, ok: false, error: outcome.error };
    sendOnChannel(s, ack);
  }

  async function onOffer(sid: string, sdp: string): Promise<void> {
    if (stopped || sessions.has(sid)) return; // ignore a duplicate/late offer for an sid
    if (sessions.size >= MAX_SESSIONS) return;

    const pc = new RTCPeerConnection({ iceServers });
    const s: Session = { sid, pc, channel: null, unsubscribe: null, open: false };
    sessions.set(sid, s);

    // The phone (offerer) creates the channel; we receive it here.
    pc.onDataChannel.subscribe((channel) => wireChannel(s, channel));

    // Trickle our ICE candidates back to the phone over the relay.
    pc.onIceCandidate.subscribe((candidate: RTCIceCandidate | undefined) => {
      deps.sendSignal({ k: 'rtc-ice', sid, candidate: candidate ? toWire(candidate) : null });
    });

    pc.connectionStateChange.subscribe((state) => {
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        const live = sessions.get(sid);
        if (live === s) teardown(s);
      }
    });

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const localSdp = pc.localDescription?.sdp;
      if (!localSdp) {
        teardown(s);
        return;
      }
      deps.sendSignal({ k: 'rtc-answer', sid, sdp: localSdp });
    } catch {
      // A malformed offer or negotiation failure — drop this attempt; the phone
      // times out and stays on the relay path.
      teardown(s);
    }
  }

  function onIce(sid: string, candidate: RtcIceCandidate | null): void {
    const s = sessions.get(sid);
    if (!s) return; // ICE for an unknown/closed session — ignore
    if (candidate === null) return; // end-of-candidates marker: nothing to add
    void s.pc
      .addIceCandidate({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? undefined,
        sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
      })
      .catch(() => {
        /* a stale/duplicate candidate — non-fatal */
      });
  }

  return {
    handleSignal(signal: RtcSignal): void {
      if (stopped) return;
      switch (signal.k) {
        case 'rtc-offer':
          void onOffer(signal.sid, signal.sdp);
          break;
        case 'rtc-ice':
          onIce(signal.sid, signal.candidate);
          break;
        case 'rtc-answer':
          // The PC is always the answerer; a peer sending an answer is malformed.
          break;
      }
    },
    openSessions: () => openCount(),
    stop(): void {
      if (stopped) return;
      stopped = true;
      for (const s of [...sessions.values()]) teardown(s);
    },
  };
}

/** werift candidate → our null-normalized wire form. */
function toWire(c: RTCIceCandidate): RtcIceCandidate {
  return {
    candidate: c.candidate,
    sdpMid: c.sdpMid ?? null,
    sdpMLineIndex: c.sdpMLineIndex ?? null,
  };
}
