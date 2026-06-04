# marudesk-mobile

The **mobile (Capacitor) thin client** for the marudesk *Model-B bridge* (stage
**B3**; see `../marudesk/docs/bridge-model-b-design.md` §3 protocol, §5 B3).

The phone **does not run the model or tools**. It sends agent commands and
renders the PC-owned `AgentChatState` that the PC streams back through the cloud
relay. Agent logic, credentials, workspace and CDP all stay on the PC.

```
 Phone (this app)  ──login(same account)──▶  Relay (cloud)  ◀──host──  PC (marudesk)
        │  ws connect?role=client&token=jwt          │  brokers same-account host↔client
        │  cmd: send/abort/respond/approve/reset      ▼
        └─ renders  ◀── event: AgentChatState snapshots ──┘
```

## Stack

React 19 + Vite 8 + TypeScript 6 (strict) + zustand + lucide-react, packaged
with Capacitor 6. Brand-continuous with the marudesk desktop dark theme, but laid
out **for touch** (bottom-anchored composer, large tap targets, keyboard-safe
insets, pull-to-reconnect). No cross-package imports — the agent/relay wire types
are a hand-kept copy in `src/types.ts`.

## Screens

| Screen | What it does |
|---|---|
| **Connect** (`screens/ConnectScreen.tsx`) | Enter/persist the relay URL (default `http://127.0.0.1:8788`), `/health` "test connection", and a **stubbed** "Scan QR" affordance. |
| **Login** (`screens/LoginScreen.tsx`) | Email/password **login + self-signup** (fully functional against the relay) plus **Sign in with Google / GitHub** buttons that open the relay's web OAuth flow (503 → "configure on PC/relay"). |
| **Chat** (`screens/ChatScreen.tsx`) | The AI Chat surface: streaming message list, **collapsible Thinking blocks**, **tool-call cards**, inline **approval** + **ask_user** prompts, a send/stop composer, and connection/empty/error states. |
| **Account** (`screens/AccountScreen.tsx`) | Logged-in identity, relay + PC-host connection status, reconnect, logout. |

A tiny hand-rolled router lives in the store (`route: 'connect'|'login'|'chat'|'account'`).

## The transport seam (the only B2-dependent part — isolated)

Everything the UI knows about "where the agent lives" is the `Transport`
interface in **`src/transport/types.ts`**:

```ts
interface Transport {
  connect(relayUrl, accessToken): Promise<void>;
  disconnect(): void;
  onState(cb: (state: AgentChatState) => void): Unsubscribe;
  onStatus(cb: (info: TransportStatusInfo) => void): Unsubscribe;
  send<K>(cmd: 'send'|'abort'|'respond'|'approve'|'reset'|'snapshot', args): Promise<void>;
}
```

Two implementations, selected by the factory in `src/transport/index.ts`
(`USE_RELAY` flag, **defaults to the stub**):

- **`StubTransport`** (default, dev) — an in-memory fake. No relay, no PC, no
  network. It fabricates a believable turn (user msg → thinking → streamed reply
  → `read_console` tool card → gated `eval_js` **approval** → `ask_user`
  **question** → completion) so the **whole UI is demoable standalone**. All
  commands are wired (`approve`/`respond`/`abort`/`reset`/`snapshot`).
- **`RelayTransport`** — a **clearly-marked skeleton** with a precise
  B2-integration note at the top of `src/transport/RelayTransport.ts` and
  `TODO(B2)` markers at each fill-in point. It does **not** block the build.

### B2 integration seam (what's left to wire after B2 lands)

The header of `RelayTransport.ts` is the authoritative spec; in short:

1. **Connect**: `ws(s)://<relay>/connect?role=client&token=<accessToken>`; first
   frame is `{type:'ready', role, accountId, peers}` → drive `hostOnline` from
   `peers.hosts > 0`.
2. **Inbound**: relay forwards `{type:'relay', from:'host', payload}`; `payload`
   is a `RelayHostMessage` — `{k:'event', state}` → `onState`, `{k:'ack', cid,
   ok, result?, error?}` → settle the matching `send()`. Validate defensively
   (copy `parseRelayHostMessage` from `marudesk/shared/remote.ts` locally).
3. **Outbound**: wrap a `RelayCommand` as `{payload:{k:'cmd', cid, cmd, args}}`
   (the relay hub peels exactly one `payload` layer). `args` is exactly
   `TransportCommandArgs[cmd]`.
4. On `ready`, immediately send a `snapshot` command (multi-head join).
5. Refresh `accessToken` via `/auth/refresh` on an auth-close, then reconnect.

Flip `USE_RELAY = true` in `src/transport/index.ts` once it's implemented — **no
screen changes needed**.

## Auth & storage

- `src/auth/relayClient.ts` — typed fetch wrapper for the relay's auth REST
  (`/auth/signup|login|refresh|logout`, `/me`, `/health`, `/auth/{google,github}`).
- `src/auth/storage.ts` — token/URL persistence via Capacitor `Preferences`
  (OS-backed on device) with a `localStorage` fallback for the web/PWA build.

## Develop (web / PWA — works with no relay or PC)

```bash
npm install
npm run dev        # Vite dev server; the app boots on StubTransport
```

Open it, tap **Continue** → **Log in** (any input, the stub ignores credentials
once you reach Chat — or use a real relay; see below) → drive the fabricated
chat/approval/question flow.

### Run against a real relay (dev)

Boot the relay (`../relay`: `npm start`, default `:8788`) and the PC host (B2),
both logged into the **same account**, then flip `USE_RELAY` in
`src/transport/index.ts` once `RelayTransport` is wired.

## Verify

```bash
npm run typecheck   # tsc -b (strict) → 0 errors
npm run build       # vite build → dist/ (the web/PWA + Capacitor webDir)
npm run smoke         # runs both headless smoke suites
npm run smoke:stub    # StubTransport data-path test
npm run smoke:storage # native-storage fallback boot test
```

`npm run smoke:stub` drives the same command sequence the screens issue
(connect -> send -> approve -> respond -> reset) against `StubTransport` and
asserts the `AgentChatState` lifecycle the Chat UI renders, proving the UI's
data path end to end without a browser.

`npm run smoke:storage` simulates a native shell where Capacitor Preferences is
unavailable and proves storage reads/writes fall back instead of leaving app
hydration stuck behind the boot spinner.

## Capacitor / Android APK

`capacitor.config.ts`: `appId: com.marudesk.mobile`, `appName: marudesk`,
`webDir: dist`. The Android project has been scaffolded with `npx cap add
android` (the `android/` folder is **gitignored** — it's regenerable).

> **This environment has no JDK / Android SDK**, so a *signed `.apk`* was **not
> produced here**. The web/PWA build and the Capacitor scaffold are complete; the
> APK is one toolchain install away.

### Prerequisites to build the APK

1. **JDK 17** (Temurin/Adoptium) — set `JAVA_HOME`.
2. **Android SDK** — via Android Studio or `cmdline-tools`; set `ANDROID_HOME`
   (a.k.a. `ANDROID_SDK_ROOT`) and accept licenses (`sdkmanager --licenses`).
   Install a platform + build-tools (e.g. `platforms;android-34`,
   `build-tools;34.0.0`).
3. Gradle is vendored via the project's `gradlew` wrapper — no separate install.

### Build steps

```bash
npm run build                 # 1) produce web dist/
npx cap sync android          # 2) copy dist/ + plugins into android/
cd android
./gradlew assembleDebug       # 3) → android/app/build/outputs/apk/debug/app-debug.apk
# release (signed): configure a keystore + signingConfig, then:
# ./gradlew assembleRelease
```

Open in Android Studio instead with `npx cap open android` to run on a
device/emulator.

## Deferred (not in B3)

- **Live `RelayTransport`** wiring (waits on B2 finalizing the relay protocol).
- **Real OAuth** token return — the relay's web callback currently returns tokens
  in the navigation body; mobile needs the **app deep-link + one-time code
  exchange** (design §6.1 **M4**, a B4 item).
- **QR scan** pairing (camera/barcode plugin) — affordance is a placeholder.
- **Signed APK** packaging (needs the Android toolchain above).
- Remote **self-approval policy** confirmation (design §6) — this UI assumes the
  phone may approve gated tools; if the PC pins approvals locally it simply won't
  surface `pendingApproval` to the phone.
```
