import assert from 'node:assert/strict';
import { RTCPeerConnection } from 'werift';
import type { RTCDataChannel, RTCIceCandidate } from 'werift';
import type { AgentChatState, AgentSendInput, AgentSendResult } from '../../shared/agent';
import { emptyAgentChatState } from '../../shared/agent';
import { parseRelayHostMessage, type RtcSignal } from '../../shared/remote';
import type { AgentApi } from './dispatch';
import { startWebrtcHost, type WebrtcHost } from './webrtc-host';

/**
 * Headless e2e for the PC-side WebRTC host (electron/server/webrtc-host.ts). Run
 * with `npm run harness:webrtc`. No relay and no network: it stands up the REAL
 * werift host plus a werift "mock phone" (the offerer) and wires their SDP/ICE
 * signaling straight to each other in-process (iceServers:[] → loopback host
 * candidates only). It then asserts the full P2P round-trip over the resulting
 * RTCDataChannel — proving the data channel carries the SAME command/event/ack
 * protocol the relay path does, dispatched through the SHARED ./dispatch.ts:
 *
 *   - the channel actually opens (ICE connects over loopback);
 *   - on open the host pushes an {k:'event',state} snapshot;
 *   - {k:'cmd',cmd:'snapshot'} → {k:'ack',ok:true} whose result is the state;
 *   - {k:'cmd',cmd:'send',...} dispatches to the stubbed loop.startTurn once with
 *     the shared-parser-validated args;
 *   - a malformed command is acked ok:false (untrusted peer input, not a crash);
 *   - a loop-emitted state is forwarded over the channel as {k:'event'}.
 *
 * Teardown closes both peers + stops the host so no UDP sockets/timers leak.
 */

const SID = 'sid-webrtc-harness';

/* ── a stubbed agent loop (records calls; drives the event subscriber) ─────── */

function buildStubAgent(): {
  agent: AgentApi;
  subscribe: (cb: (s: AgentChatState) => void) => () => void;
  emit: (s: AgentChatState) => void;
  calls: { startTurn: AgentSendInput[] };
} {
  const calls = { startTurn: [] as AgentSendInput[] };
  const state: AgentChatState = { ...emptyAgentChatState(), status: 'idle' };
  const subs = new Set<(s: AgentChatState) => void>();
  const agent: AgentApi = {
    async startTurn(input: AgentSendInput): Promise<AgentSendResult> {
      calls.startTurn.push(input);
      return { ok: true, turnId: 'turn-from-stub' };
    },
    abortTurn: () => true,
    respond: () => true,
    approveTool: () => true,
    snapshot: () => state,
    reset: () => true,
  };
  return {
    agent,
    subscribe: (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    emit: (s) => {
      for (const cb of subs) cb(s);
    },
    calls,
  };
}

/** werift candidate → our null-normalized wire form (mirrors webrtc-host.toWire). */
function toWire(c: RTCIceCandidate): RtcSignal & { k: 'rtc-ice' } {
  return {
    k: 'rtc-ice',
    sid: SID,
    candidate: { candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null },
  };
}

/** Poll `cond` until true or `ms` elapses; throws on timeout with `label`. */
async function waitFor(label: string, cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function main(): Promise<void> {
  let passed = 0;
  const check = (label: string, cond: boolean): void => {
    assert.ok(cond, label);
    passed += 1;
    console.log(`  ok ${passed} - ${label}`);
  };

  const stub = buildStubAgent();
  let host: WebrtcHost | null = null;
  let phone: RTCPeerConnection | null = null;
  try {
    // The phone (offerer) — created first so the host's signals can route to it.
    const phonePc = new RTCPeerConnection({ iceServers: [] });
    phone = phonePc;

    // The host's outbound signals (answer + ICE) flow straight back to the phone.
    host = startWebrtcHost({
      agent: stub.agent,
      subscribe: stub.subscribe,
      iceServers: [],
      sendSignal: (signal: RtcSignal) => {
        if (signal.k === 'rtc-answer') {
          void phonePc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        } else if (signal.k === 'rtc-ice' && signal.candidate) {
          void phonePc
            .addIceCandidate({
              candidate: signal.candidate.candidate,
              sdpMid: signal.candidate.sdpMid ?? undefined,
              sdpMLineIndex: signal.candidate.sdpMLineIndex ?? undefined,
            })
            .catch(() => {});
        }
      },
    });
    const liveHost = host;

    // The phone trickles its ICE to the host; the host opens a session on the offer.
    phonePc.onIceCandidate.subscribe((c: RTCIceCandidate | undefined) => {
      if (c) liveHost.handleSignal(toWire(c));
    });

    // The phone owns the data channel; collect host→phone messages off it.
    const inbound: ReturnType<typeof parseRelayHostMessage>[] = [];
    const channel: RTCDataChannel = phonePc.createDataChannel('agent');
    let channelOpen = false;
    channel.stateChanged.subscribe((s) => {
      if (s === 'open') channelOpen = true;
    });
    channel.onMessage.subscribe((data) => {
      const raw = typeof data === 'string' ? data : data.toString('utf8');
      try {
        inbound.push(parseRelayHostMessage(JSON.parse(raw)));
      } catch {
        /* ignore */
      }
    });

    // Kick off negotiation: offer → host.
    const offer = await phonePc.createOffer();
    await phonePc.setLocalDescription(offer);
    liveHost.handleSignal({ k: 'rtc-offer', sid: SID, sdp: phonePc.localDescription!.sdp });

    // ── the channel opens over loopback ─────────────────────────────────────
    await waitFor('data channel to open', () => channelOpen);
    check('RTCDataChannel opened P2P over loopback (ICE connected)', channelOpen);
    check('host reports one open P2P session', liveHost.openSessions() === 1);

    // ── on open the host pushes a snapshot {k:'event'} ──────────────────────
    await waitFor('on-open event push', () => inbound.some((m) => m?.k === 'event'));
    check('host pushed an {k:event,state} snapshot on open', inbound.some((m) => m?.k === 'event'));

    // ── snapshot command → ack carrying the state ───────────────────────────
    channel.send(JSON.stringify({ k: 'cmd', cid: 'cid-snap', cmd: 'snapshot', args: undefined }));
    await waitFor('snapshot ack', () => inbound.some((m) => m?.k === 'ack' && m.cid === 'cid-snap'));
    const snapAck = inbound.find((m) => m?.k === 'ack' && m.cid === 'cid-snap');
    check('snapshot command → {k:ack, ok:true} over the data channel', snapAck?.k === 'ack' && snapAck.ok === true);
    check(
      "the ack's result is the AgentChatState snapshot",
      !!(snapAck?.k === 'ack' && snapAck.result && (snapAck.result as AgentChatState).status === 'idle'),
    );

    // ── send command → dispatched to the stubbed loop with validated args ───
    channel.send(
      JSON.stringify({
        k: 'cmd',
        cid: 'cid-send',
        cmd: 'send',
        args: { provider: 'anthropic', model: 'claude-x', prompt: 'hi over p2p', captures: [] },
      }),
    );
    await waitFor('send ack', () => inbound.some((m) => m?.k === 'ack' && m.cid === 'cid-send'));
    const sendAck = inbound.find((m) => m?.k === 'ack' && m.cid === 'cid-send');
    check('send command → {k:ack, ok:true}', sendAck?.k === 'ack' && sendAck.ok === true);
    check('dispatched to loop.startTurn exactly once', stub.calls.startTurn.length === 1);
    check(
      'startTurn received the SHARED-parser-validated args',
      stub.calls.startTurn[0]?.provider === 'anthropic' &&
        stub.calls.startTurn[0]?.model === 'claude-x' &&
        stub.calls.startTurn[0]?.prompt === 'hi over p2p',
    );

    // ── a malformed command is acked ok:false (untrusted peer input) ────────
    channel.send(JSON.stringify({ k: 'cmd', cid: 'cid-bad', cmd: 'send', args: { nope: true } }));
    await waitFor('bad-command ack', () => inbound.some((m) => m?.k === 'ack' && m.cid === 'cid-bad'));
    const badAck = inbound.find((m) => m?.k === 'ack' && m.cid === 'cid-bad');
    check('malformed send → {k:ack, ok:false, error}', badAck?.k === 'ack' && badAck.ok === false);
    check('the rejected command did NOT call startTurn again', stub.calls.startTurn.length === 1);

    // ── a loop-emitted state is forwarded over the channel as {k:event} ─────
    const before = inbound.filter((m) => m?.k === 'event').length;
    stub.emit({ ...emptyAgentChatState(), status: 'working' });
    await waitFor('forwarded event', () => inbound.filter((m) => m?.k === 'event').length > before);
    const lastEvent = [...inbound].reverse().find((m) => m?.k === 'event');
    check(
      'a loop-emitted state is forwarded over the channel as {k:event}',
      lastEvent?.k === 'event' && lastEvent.state.status === 'working',
    );

    console.log(`\nwebrtc-host harness: ${passed} assertions passed`);
  } finally {
    host?.stop();
    if (phone) await phone.close().catch(() => {});
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('webrtc-host harness FAILED:', err);
    process.exit(1);
  },
);
