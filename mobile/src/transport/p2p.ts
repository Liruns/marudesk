import {
  parseRelayHostMessage,
  type RelayHostMessage,
  type RtcIceCandidate,
  type RtcSignal,
} from './relay-frames';

/**
 * The phone's WebRTC OFFERER (docs/webrtc-p2p-design.md). Owned by RelayTransport:
 * once the relay reports a host, this opens a direct RTCDataChannel to the PC so
 * agent traffic flows P2P (across NATs, via STUN hole-punching) instead of through
 * the cloud. It runs the SAME command/event protocol the relay path does — the
 * channel just carries the JSON. The relay only ferries the SDP/ICE handshake
 * (via {@link P2pDeps.sendSignal}) and stays as the hot fallback if P2P never
 * opens or later drops. Uses the WebView's native WebRTC — no dependency.
 *
 * Untrusted in: `answer`/`ice` arrive over the dumb relay, and channel messages
 * come from the (same-account) PC; both are shape-validated before use.
 */

/** Free public STUN for hole-punching. No agent bytes flow through it — discovery only. */
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

export type P2pDeps = {
  /** A per-attempt session id (minted by the transport) so signals can't cross-wire. */
  sid: string;
  /** Send a signaling message to the PC over the relay. */
  sendSignal: (signal: RtcSignal) => void;
  /** A validated host message arrived over the data channel (event / ack). */
  onHostMessage: (msg: RelayHostMessage) => void;
  /** The data channel opened — sends should now prefer P2P. */
  onOpen: () => void;
  /** The data channel closed/failed — fall back to the relay. */
  onClose: () => void;
};

export class P2pUpgrade {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private closed = false;
  private opened = false;

  constructor(private readonly deps: P2pDeps) {}

  /** Begin negotiation: create the channel + offer and send it to the PC. */
  async start(): Promise<void> {
    if (this.closed || this.pc) return;
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    } catch {
      this.deps.onClose();
      return;
    }
    this.pc = pc;

    // The offerer owns the channel; the PC receives it via ondatachannel.
    const channel = pc.createDataChannel('agent');
    this.channel = channel;
    channel.onopen = () => {
      if (this.closed) return;
      this.opened = true;
      this.deps.onOpen();
    };
    channel.onclose = () => this.fail();
    channel.onmessage = (ev: MessageEvent) => {
      const raw = typeof ev.data === 'string' ? ev.data : null;
      if (raw === null) return;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        return;
      }
      const msg = parseRelayHostMessage(value);
      if (msg) this.deps.onHostMessage(msg);
    };

    pc.onicecandidate = (ev: RTCPeerConnectionIceEvent) => {
      this.deps.sendSignal({ k: 'rtc-ice', sid: this.deps.sid, candidate: toWire(ev.candidate) });
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed' || s === 'disconnected') this.fail();
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (this.closed) return;
      this.deps.sendSignal({ k: 'rtc-offer', sid: this.deps.sid, sdp: offer.sdp ?? '' });
    } catch {
      this.fail();
    }
  }

  /** Apply an inbound signaling message (the PC's answer / ICE). */
  handleSignal(signal: RtcSignal): void {
    if (this.closed || signal.sid !== this.deps.sid) return; // not ours / stale attempt
    const pc = this.pc;
    if (!pc) return;
    if (signal.k === 'rtc-answer') {
      void pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp }).catch(() => this.fail());
    } else if (signal.k === 'rtc-ice' && signal.candidate) {
      void pc
        .addIceCandidate({
          candidate: signal.candidate.candidate,
          sdpMid: signal.candidate.sdpMid ?? undefined,
          sdpMLineIndex: signal.candidate.sdpMLineIndex ?? undefined,
        })
        .catch(() => {
          /* a stale/duplicate candidate — non-fatal */
        });
    }
    // rtc-offer over this path would be malformed (the phone is the offerer) — ignore.
  }

  /** Whether the data channel is currently open (sends can use P2P). */
  isOpen(): boolean {
    return this.opened && this.channel?.readyState === 'open';
  }

  /** Send a JSON command string over the channel. Returns false if it isn't open. */
  send(json: string): boolean {
    if (!this.isOpen() || !this.channel) return false;
    try {
      this.channel.send(json);
      return true;
    } catch {
      return false;
    }
  }

  /** Tear down the peer. Idempotent. */
  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.opened = false;
    try {
      this.channel?.close();
    } catch {
      /* ignore */
    }
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.channel = null;
    this.pc = null;
  }

  private fail(): void {
    if (this.closed) return;
    const wasOpen = this.opened;
    this.stop();
    // Tell the transport to fall back to the relay (only meaningful once; stop()
    // flips `closed` so repeated state-change events don't re-notify).
    void wasOpen;
    this.deps.onClose();
  }
}

/** Browser RTCIceCandidate → our null-normalized wire form (`null` = end-of-candidates). */
function toWire(candidate: RTCIceCandidate | null): RtcIceCandidate | null {
  if (!candidate || !candidate.candidate) return null;
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid ?? null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
  };
}
