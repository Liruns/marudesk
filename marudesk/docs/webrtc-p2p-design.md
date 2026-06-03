# WebRTC P2P Bridge Design

Status: implemented (host + client + signaling). Companion to
`bridge-model-b-design.md` (the cloud relay) — this layers a direct
peer-to-peer path on top of it so agent traffic stops round-tripping through
the cloud on most networks, and works across different LANs without Tailscale.

## Why

Same-LAN already works (the phone reaches the PC's `192.168.x` directly, T2).
Across different networks both peers are behind NAT with no public address, so
they cannot find each other unaided. The two prior answers each have a cost:

- **Tailscale (T2 direct)** — works cross-network, end-to-end encrypted, no
  server to host, but the user must install and log into Tailscale.
- **Cloud relay (Model B)** — works on any network, nothing for the user to
  install, but every byte of agent traffic flows through a server you host.

WebRTC gives the best of both **inside the apps**: a direct, DTLS-encrypted
data channel established by STUN hole-punching. The user installs nothing; you
still host one small server, but it only carries the handshake (and a rare
fallback), not the traffic.

## The one unavoidable piece

NAT traversal fundamentally needs a public **rendezvous** to introduce the two
peers. We do not add one: we reuse the **existing relay** as the signaling
channel. Because the relay is a payload-agnostic pipe (it forwards
`{type:'relay', from, payload}` and never inspects `payload`), the new
signaling messages pass through it with **zero relay changes**.

## Topology

```
                ┌──────────── relay (Bridge Model B) ────────────┐
                │   forwards opaque payloads, same account only   │
   PC (host) ───┴──── ① SDP offer/answer + ICE (rtc-*) ──────┴─── phone (client)
       │                                                          │
       └──── ② STUN hole-punch → RTCDataChannel (DTLS) ──────────┘
                     carries the SAME RelayCommand / RelayHostMessage
```

Roles: the **phone is the offerer**, the **PC is the answerer**. The phone
initiates the upgrade once the relay reports a host is online.

## Wire protocol (signaling)

New `payload` discriminators, defined in `shared/remote.ts` and mirrored
(no cross-package import) in `mobile/src/transport/relay-frames.ts`:

| Message       | Direction       | Fields                                  |
| ------------- | --------------- | --------------------------------------- |
| `rtc-offer`   | client → host   | `sid`, `sdp`                            |
| `rtc-answer`  | host → client   | `sid`, `sdp`                            |
| `rtc-ice`     | either          | `sid`, `candidate` (`null` = end)       |

`sid` is a per-attempt session id the offerer mints so concurrent phones (or a
stale retry) can't cross-wire; each side ignores signals whose `sid` it didn't
start/accept. Both sides treat these as **untrusted** (they arrive over the
dumb relay) and validate with `parseRtcSignal` before WebRTC sees them.

Once the channel is open it carries the **unchanged** agent protocol — the same
`{k:'cmd',cid,cmd,args}` the relay path uses, with the host replying
`{k:'event',state}` / `{k:'ack',cid,ok,result,error}`. The only difference: the
channel sends the command JSON directly (no `{payload}` relay envelope).

## PC host (`electron/server/webrtc-host.ts`)

- Runs in the **Electron main process** using **werift** (pure-TS WebRTC — no
  native build, no electron-rebuild), right next to the agent loop and
  `relay-client`. This keeps every remote command on the **single validated
  main-process choke point**: a data-channel command is validated + executed
  through the **shared `dispatch.ts`**, so the L-1 self-approval guard and all
  parsers are reused verbatim. A P2P peer is exactly as untrusted as a relayed
  one.
- `relay-client.ts` routes inbound `rtc-*` frames to the host and carries its
  outbound answer/ICE over the existing relay socket (`sendPayload`). The data
  channel **survives relay reconnects** — its lifetime is the client's.
- Hardening: free public STUN for discovery, capped concurrent sessions,
  backpressure on event forwarding, teardown on connection-state failure.

## Phone client (`mobile/src/transport/p2p.ts` + `RelayTransport`)

- Uses the WebView's **native `RTCPeerConnection`** — no dependency.
- `RelayTransport` upgrades transparently: after `ready` (host online) it starts
  a `P2pUpgrade`, sends an offer over the relay, and once the channel opens
  routes `send()` through it. Inbound events/acks are handled identically
  whether they arrive over the channel or the relay (`handleHostMessage`), so
  `cid` correlation is transport-agnostic.
- The UI (`Transport` interface) is unchanged; a new optional
  `TransportStatusInfo.p2p` drives a "PC · direct" vs "PC · relay" chip.

## Graceful degradation (3 tiers)

1. **Same LAN** → direct LAN connection (T2, unchanged).
2. **Different LAN** → WebRTC P2P direct (STUN hole-punch); traffic skips the
   relay.
3. **Hostile/symmetric NAT (~10–20%)** → the relay path (Bridge Model B) stays
   hot as the fallback: if P2P never opens or later drops, `send()` falls back
   to the relay socket and the session continues. If the relay drops while P2P
   is open, the session stays up on the channel and the relay reconnects quietly.

A future TURN server can be slotted in via the `iceServers` override
(`startWebrtcHost({ iceServers })`) for the last tier without a protocol change.

## Verification

- `npm run harness:webrtc` — two werift peers over loopback (`iceServers: []`)
  prove the channel opens and snapshot/send/ack/event all round-trip through the
  shared dispatcher, including an untrusted malformed command acked `ok:false`
  (11 assertions). This exercises the exact wire shapes the phone client mirrors.
- `npm run harness:relay-bridge` continues to validate the relay path the P2P
  path falls back to.
- Real-device P2P (WebView ↔ packaged app across networks) is a manual check;
  the protocol/dispatch correctness is covered headlessly by the harness above.
