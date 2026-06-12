# marudesk-mobile

The mobile (Capacitor) thin client for the marudesk Model-B bridge (stage B3;
see `../marudesk/docs/bridge-model-b-design.md`).

The phone does not run the model or tools. It sends agent commands and renders
the PC-owned `AgentChatState` that the PC streams back over either the direct or
relay path. Agent logic, credentials, workspace access, and CDP all stay on the
PC.

## Stack

React 19 + Vite 8 + TypeScript 6 (strict) + zustand + lucide-react, packaged
with Capacitor 6. The UI follows the marudesk desktop dark theme, but it is
laid out for touch with a bottom-anchored composer, large tap targets,
keyboard-safe insets, and pull-to-reconnect. The mobile package keeps its own
wire types in `src/types.ts`; it does not import runtime contracts across
package boundaries.

## Screens

| Screen | What it does |
|---|---|
| **Connect** (`screens/ConnectScreen.tsx`) | Enter and persist the relay URL (default `http://127.0.0.1:8788`), test `/health`, sign in through the relay path, and pair to a PC host by QR or pasted payload for direct credentials. |
| **Login** (`screens/LoginScreen.tsx`) | Email/password login and self-signup against the relay, plus Google and GitHub buttons that open the relay web OAuth flow. |
| **Chat** (`screens/ChatScreen.tsx`) | Streaming message list, collapsible thinking blocks, tool-call cards, inline approval and `ask_user` prompts (file-edit approvals show the proposed diff above Approve/Deny), per-edit patch-review cards (PC-projected bounded unified diffs with +N/−M stats, expandable colored diff, and Revert on applied edits), a send/stop composer, and connection/empty/error states. Bottom sheets pick the PC workspace (`chat/WorkspaceSheet.tsx`), resume or start saved conversations (`chat/SessionsSheet.tsx`), and choose the provider/model + reasoning effort (`chat/ModelSheet.tsx`). |
| **Account** (`screens/AccountScreen.tsx`) | Logged-in identity, relay and PC-host connection status, reconnect, logout, and the Notifications toggle (local alerts while backgrounded: new approval requests, finished/failed turns, and background-task completion — `lib/notifications.ts`, via `@capacitor/local-notifications` natively and the Web Notifications API on web/PWA). |

A small hand-rolled router lives in the store
(`route: 'connect'|'login'|'chat'|'account'`).

## Transport boundary

Everything the UI knows about "where the agent lives" is the `Transport`
interface in `src/transport/types.ts`:

```ts
interface Transport {
  connect(relayUrl, accessToken): Promise<void>;
  disconnect(): void;
  onState(cb: (state: AgentChatState) => void): Unsubscribe;
  onStatus(cb: (info: TransportStatusInfo) => void): Unsubscribe;
  send<K>(
    cmd: 'send' | 'abort' | 'respond' | 'approve' | 'reset' | 'snapshot'
       | 'edit-plan-step' | 'set-approval-mode' | 'set-reasoning-effort',
    args,
  ): Promise<void>;
  // Optional capabilities (direct + stub transports):
  catalog?: TransportCatalog;          // PC models/workspaces/sessions + resume
  setWorkspace?(id: string | null): void; // pin the event stream to a workspace
}
```

Transport selection has two layers:

- `StubTransport` is the default dev transport. It is an in-memory fake with no
  relay, no PC, and no network. It fabricates a believable turn so the whole UI
  remains demoable standalone. All command paths are wired
  (`approve`/`respond`/`abort`/`reset`/`snapshot`).
- `RelayTransport` is the real relay-backed transport. Enable it with
  `VITE_USE_RELAY=true` in `src/transport/index.ts` when you want the phone
  client to authenticate against the relay and stream PC-owned agent state over
  the cloud path.
- `DirectTransport` is installed by the app store when QR or pasted pairing
  credentials are stored locally. Once a host pairing has been completed, direct
  mode is the normal runtime path for direct access to the PC host.

In every mode, the mobile client stays thin: the phone renders state and sends
commands, while the PC keeps model execution, tools, approvals, and workspace
access.

## Workspace + session continuity (direct mode)

The point of the phone is to drive the SAME conversation the desktop shows, so
the chat is scoped to a PC workspace:

- The store pins a workspace (`workspaceId`, persisted; defaults to the PC's
  active workspace on first connect). `DirectTransport` opens
  `GET /agent/events?workspace=<id>`, which streams that workspace's ACTIVE
  thread — exactly what the desktop UI renders for it — and `send`/`reset`
  carry the same `workspaceId`, so a phone turn lands in the conversation the
  desktop is looking at, and vice versa.
- The sessions sheet lists that scope's saved conversations
  (`GET /agent/sessions?workspace=`) and resumes one with
  `POST /agent/resume-session` — the next snapshot repaints both phone and
  desktop with the resumed transcript. "New chat" is a scoped `reset`; the
  first send then starts (and persists) a fresh session both surfaces share.
- The model sheet is fed by `GET /agent/models` (the PC's connected providers
  only are selectable) and the picked provider/model ride each `send`, so the
  model is changeable per chat from the phone. Reasoning effort mirrors the
  desktop dial through `chat.reasoningEffort` + the `set-reasoning-effort`
  command (a PC setting; applies on the next turn).

The cloud relay path doesn't carry the catalog routes (its protocol is frozen),
so in relay mode the pickers hide and the chat stays global-scope.

## Pairing and connection modes

- Relay auth: sign in against the relay, then connect through `RelayTransport`
  when `VITE_USE_RELAY=true`.
- Direct pairing: scan or paste the host-issued QR payload to persist direct
  credentials, then reconnect over `DirectTransport`.
- QR scanning: the app dynamically imports
  `@capacitor-mlkit/barcode-scanning` when the native plugin is installed and
  available. Paste entry remains a first-class fallback and is the expected path
  on web/PWA builds or native shells without the plugin.

## Auth and storage

- `src/auth/relayClient.ts`: typed fetch wrapper for relay auth REST endpoints
  (`/auth/signup|login|refresh|logout`, `/me`, `/health`, `/auth/{google,github}`).
- `src/auth/storage.ts`: token and URL persistence via Capacitor `Preferences`
  with a `localStorage` fallback for the web/PWA build.

## Develop

```bash
npm install
npm run dev
```

`npm run dev` starts the Vite web/PWA client and defaults to `StubTransport`
unless configured otherwise.

Useful dev paths:

- Stub/demo: continue into the fabricated chat, approval, and question flow
  with the default transport.
- Relay: set `VITE_USE_RELAY=true`, start the relay and PC host, and sign in
  with a same-account relay user.
- Direct: pair with a host QR payload by scan or paste; once direct credentials
  are stored, the app uses `DirectTransport`.

### Run against a real relay

Boot the relay (`../relay`: `npm start`, default `:8788`) and the PC host, both
logged into the same account, then start the mobile client with
`VITE_USE_RELAY=true`.

## Verify

```bash
npm run typecheck    # tsc -b (strict)
npm run build        # vite build -> dist/
npm run smoke        # runs stub, storage, pairing, relay, and notifications smoke suites
npm run smoke:stub   # StubTransport data-path test
npm run smoke:storage
npm run smoke:pairing
npm run smoke:relay
npm run smoke:notifications
```

`npm run smoke:stub` drives the same command sequence the screens issue
(`connect -> send -> approve -> respond -> reset`) against `StubTransport` and
asserts the `AgentChatState` lifecycle the Chat UI renders.

`npm run smoke:storage` simulates a native shell where Capacitor Preferences is
unavailable and proves storage reads and writes fall back instead of leaving app
hydration stuck behind the boot spinner.

`npm run smoke:pairing` covers the mobile pairing client against a fake PC
`/pair` endpoint. It proves scanned or pasted payloads produce `DirectCreds`,
fall back from an unreachable URL to a reachable one, and reject invalid or
expired payloads before any network request.

`npm run smoke:relay` covers the relay-backed transport seam with a fake
WebSocket. It verifies relay URL conversion, ready frames, command envelopes,
ack resolution/rejection, malformed-frame ignores, and relay-delivered agent
events.

`npm run smoke:notifications` covers the local-notification seam: the pure
snapshot diffing fires exactly one event per transition (background task
done/error, new approval, turn completed/failed), baselines the first snapshot,
de-dupes re-emits, and tolerates older-host snapshots without the optional
fields.

## Capacitor / Android APK

`capacitor.config.ts` uses `appId: com.marudesk.mobile`,
`appName: marudesk`, and `webDir: dist`. The Android project has been
scaffolded with `npx cap add android`; the `android/` folder is gitignored and
regenerable.

This environment does not include the JDK or Android SDK, so a signed `.apk`
was not produced here. The web/PWA build and Capacitor scaffold are complete.

### Prerequisites to build the APK

1. JDK 17 (Temurin/Adoptium), with `JAVA_HOME` set.
2. Android SDK via Android Studio or `cmdline-tools`, with `ANDROID_HOME`
   (`ANDROID_SDK_ROOT`) set and licenses accepted. Install a platform and
   build-tools such as `platforms;android-34` and `build-tools;34.0.0`.
3. Gradle is vendored through the project's `gradlew` wrapper.

### Build steps

```bash
npm run build
npx cap sync android
cd android
./gradlew assembleDebug
# release: configure a keystore + signingConfig, then:
# ./gradlew assembleRelease
```

Open the native project in Android Studio with `npx cap open android` to run on
a device or emulator.

## Remaining limitations

- Real OAuth token return still needs the app deep-link and one-time code
  exchange path; the relay web callback currently returns tokens in the
  navigation body.
- Native QR scanner packaging depends on shipping the optional
  `@capacitor-mlkit/barcode-scanning` plugin in the target shell. When it is not
  installed or unavailable, paste pairing remains the supported fallback.
- Signed APK packaging still depends on the Android toolchain above.
- Remote self-approval policy confirmation is still a product decision. This UI
  assumes the phone may approve gated tools; if the PC pins approvals locally,
  it simply will not surface `pendingApproval` to the phone.
