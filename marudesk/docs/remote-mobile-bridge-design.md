# Remote / Mobile Bridge — PC를 폰에서 조작하는 self-hosted 구조 (v6)

> 작성: 2026-06-01. 사용자 지시(요약): "Openclaw / Hermes 처럼 **PC에 설치해두면 내 PC에서
> 돌아가고, 핸드폰(APK)으로도 조작**할 수 있게. 폰에서 PC에 연결하면 PC에서 쓰던 AI Chat을
> 그대로 쓸 수 있어야 함. 연결·소유권 확인을 위해 **자체 회원가입 + Google/GitHub OAuth 로그인**이
> 필요하고, **PC에 로그인한 동일 유저만** 그 PC를 조작 가능해야 함. 그리고 이 Electron 앱이
> **PC 자체를 조작**(브라우저/폴더/파일 열기 등)할 수 있어야 함. APK를 위해 디자인·메뉴 확장."
>
> 이 문서는 그 5개 트랙 — ① DevTools 고도화 ② MCP 고도화 ③ PC↔모바일 연결 인프라 ④ 모바일
> 앱(APK)+사용자 인증 ⑤ PC 원격 제어 — 을 하나의 일관된 아키텍처로 묶는다. ③④⑤가 새 메가
> 프로젝트이고, 이 문서의 중심이다. ①②는 기존 시스템의 연장이라 §7에서 연결만 정리한다.

---

## 0. 핵심 결정 (Architecture decisions)

가장 중요한 통찰: **기존 agent 루프 구조가 이미 client-server를 닮았다.** main이 권위 있는
`AgentChatState`를 소유하고, `agent:event` 스냅샷을 렌더러로 push하며, 렌더러는 그 스냅샷의
순수 projection이다(docs/agentic-chat-design §8). 즉 **렌더러는 "전송 수단이 IPC인 thin
client"**다. 모바일 앱은 *전송 수단을 WebSocket으로 바꾼 또 하나의 렌더러*가 된다. 새 도메인
로직을 만들 필요가 거의 없다 — 기존 IPC 표면을 네트워크로 중계하는 **bridge** 한 겹이면 된다.

| # | 결정 | 선택 | 근거 |
|---|---|---|---|
| D1 | 토폴로지 | **PC = 호스트/서버, 폰 = thin client** | 모델 자격증명·워크스페이스·CDP·터미널이 전부 PC에 있음. 폰은 PC agent의 "remote head". Openclaw/Hermes 모델과 동일. |
| D2 | 서버 전송 | **HTTP(REST) + WebSocket**, 둘 다 in-process(Electron main) | `agent:event` 스냅샷 스트림 = WS 푸시에 1:1 대응. 기존 invoke = REST/WS request. 새 의존성 최소(내장 `http` + 가벼운 `ws`). |
| D3 | 연결 범위(v1) | **같은 LAN**(QR 페어링), 프로토콜은 tunnel/cloud 무관하게 설계 | 가장 단순·서드파티 0. T2(터널)/T3(클라우드 relay)는 클라이언트 변경 없이 base-URL만 바꿔 확장(§3). |
| D4 | 인증 권위 | **PC가 신원 권위(self-hosted)**, 폰은 **device pairing** 으로 소유자에 귀속 | 백엔드/호스팅 0. "동일 유저만 조작"을 *물리적 페어링*(PC 화면의 QR 스캔)으로 강제 — Tailscale/VS Code Tunnel/Plex 방식. 추후 cloud authority(Model B)로 확장 가능하게 토큰 설계. ⚠️확정필요 |
| D5 | 로그인 방식 | **자체 회원가입(email+pw, 로컬 해시)** + **Google/GitHub OAuth**(기존 loopback PKCE 재사용) | 사용자가 명시한 3종 전부. OAuth는 *PC 소유자 신원* 확립에 쓰고, 폰 권한은 그 소유자에 묶인 device token. |
| D6 | 모바일 프레임워크 | **공유 web client + Capacitor → APK**(+ iOS·PWA 덤) | 렌더러가 이미 React 19. thin client라 UI 재사용 최대. RN/Flutter는 전면 재작성 → 과投자. Capacitor=네이티브 쉘+보안저장+카메라(QR)+딥링크만 얇게. ⚠️확정필요 |
| D7 | PC 원격 제어 | 새 `pc-control` 도구군(agent tool) + Settings "PC Control" 권한 + 호출당 승인 | 사용자 예시(브라우저/폴더/파일 열기)는 `shell.openPath/openExternal`로 충분. 마우스/키보드 자동화(native robot)는 후속 stretch. |

**✅확정 (2026-06-01, 사용자 선택):**
- **D4 = Cloud relay (Model B)** — "무설정·어디서나 접속"을 택함. ⇒ §4 인증을 문서 초안의 "PC 단독
  권위 + device pairing(Model A)"에서 **클라우드 계정·OAuth·relay 권위(Model B)**로 **재설계**해야 한다
  (백엔드 구축·호스팅·운영 비용 수반 — 사용자가 인지하고 선택). LAN(T1)/터널(T2)은 그 위의 최적화로 후순위.
- **D6 = Capacitor**(공유 web client → APK) 확정.
- **커밋 = 트랙별**(검증되는 대로 atomic commit). **다음 작업 = ① DevTools 고도화 먼저**; 브리지(M5/M6)는 그 다음.
- 영향: **M0/M1/M4(서버 스캐폴드)는 Model B에서도 재사용**된다 — 전송(SSE+REST)·agent 중계 계층은 권위
  모델과 무관. 단 M4의 단일 bearer-token 게이트는 Model B에선 **클라우드 발급 세션/JWT**로 대체(router/SSE
  골격 유지). §4·§9(M5)는 브리지 착수 시 Model B 기준으로 다시 쓴다.

---

## 1. 전체 아키텍처

```
┌─────────────────────────── PC (Electron main, 호스트) ───────────────────────────┐
│                                                                                  │
│   renderer(React)  ──IPC──▶  agent/loop.ts  ◀── 권위 AgentChatState               │
│        ▲                        │   ▲                                            │
│        │ agent:event            │   │ send/abort/respond/approve                 │
│        │                        ▼   │                                            │
│   ┌────┴───────────── server/ (신규) ─────────────────────────┐                  │
│   │  bridge.ts   IPC 표면 ↔ 네트워크 메시지 중계(curated allowlist)│                  │
│   │  http.ts     REST: 로그인/페어링/스냅샷/파일/제어            │                  │
│   │  ws.ts       WS: agent:event 브로드캐스트 + 명령 수신        │                  │
│   │  auth/       계정·세션(JWT)·device pairing·OAuth(소유자)      │                  │
│   └──────────────────────────┬───────────────────────────────┘                  │
│                              listen 127.0.0.1 + LAN-IP : <port>  (opt-in, 기본 OFF)│
└──────────────────────────────┼───────────────────────────────────────────────────┘
                               │  WS/HTTP (+ 추후 TLS/tunnel)
                ┌──────────────┴───────────────┐
                │   Mobile (Capacitor APK)      │
                │   shared web client (React)   │
                │   - 페어링(QR 스캔) / 로그인    │
                │   - AgentChat(재사용) projection│
                │   - PC 제어 트리거             │
                └──────────────────────────────┘
```

핵심: **server/bridge 한 겹**이 "렌더러가 쓰던 invoke 채널 중 안전한 부분집합 + agent:event"를
네트워크에 노출한다. 모바일 client는 `window.marudesk.invoke`를 **네트워크 transport로 갈아끼운
shim** 위에서 기존 AgentChat 컴포넌트/스토어를 그대로 렌더한다.

### 1.1 멀티-헤드 세션
loop의 권위 state를 **연결된 모든 client에 동일 브로드캐스트**. PC에서 시작한 대화를 폰에서 이어보고,
승인/질문 응답을 어느 기기서든 처리 가능 → "어디서나 같은 세션" UX(의도된 강점). 동시 입력은 loop가
이미 단일 직렬 실행이라 안전(턴 진행 중 send는 큐/거부, 기존 규칙 유지).

---

## 2. 타깃 구조 (target structure)

```
electron/
  server/
    index.ts        # start/stop, 포트 바인딩, 수명주기(Settings 토글로 on/off)
    http.ts         # REST 라우팅(인증·페어링·스냅샷·파일·pc-control)
    ws.ts           # WebSocket: 구독(agent:event 중계) + 명령(send/abort/…)
    bridge.ts       # IPC invoke 표면 → 서버 핸들러 매핑(allowlist + 권한 스코프)
    auth/
      accounts.ts   # 소유자 계정 저장(로컬 email+pw 해시 / oauth 신원), safeStorage
      session.ts    # JWT 발급·검증(서버 시크릿은 safeStorage), access/refresh
      pairing.ts    # QR 페어링: 1회용 코드 발급→device token 교환, 기기 목록·취소
      oauth-user.ts # Google/GitHub *사용자* 로그인(oauth/flow.ts 재사용, 신원만 추출)
    middleware.ts   # requireAuth, requireOwner, rate-limit, CORS/Origin, 감사로그
  pc-control.ts     # open_path/open_external/reveal/run_command/screenshot 등 (gated)
  agent/mcp/
    sources/pc.ts   # pc-control을 MCP 도구로 노출(agent가 호출 → 폰서 조작)

shared/
  remote.ts         # 서버 프로토콜 타입(REST/WS 메시지, 페어링·토큰·기기)
  pc-control.ts     # pc-control 입력/결과 타입

mobile/             # 신규 패키지(Capacitor) — 별도 빌드 산출물(APK)
  capacitor.config.ts
  src/              # shared web client (renderer 컴포넌트 재사용 + 모바일 쉘)
    transport.ts    # invoke/emit를 HTTP+WS로 구현(IPC shim 대체)
    screens/        # Connect(QR), Login, Chat, Devices, Settings
  android/          # capacitor 안드로이드 프로젝트(APK)

src/features/server/  # PC측 Settings UI: 서버 on/off, 포트, QR 표시, 기기·세션 관리
```

전송 추상화: 현재 `window.marudesk.invoke(channel, …)` (preload). 모바일은 동일 시그니처의
`transport.invoke`를 HTTP/WS로 구현 → **AgentChat·스토어 코드 무수정 재사용**이 목표.

---

## 3. 연결 모델 & 포트 / 보안

| Tier | 범위 | 방법 | 상태 |
|---|---|---|---|
| **T1** | 같은 Wi-Fi/LAN | PC가 `LAN-IP:port`(기본 8787)로 listen. PC가 **QR**(=`https://ip:port` + 1회용 pairing code) 표시 → 폰 스캔 | **v1** |
| **T2** | 다른 네트워크 | 사용자가 터널(Tailscale / Cloudflare Tunnel / ngrok) 사용 → 폰은 터널 URL+토큰만 입력. 프로토콜 무변경 | 문서화/후속 |
| **T3** | 무설정 원격 | marudesk-hosted rendezvous relay(NAT 통과) | 미래(운영·비용) |

- **기본 OFF**: 서버는 Settings에서 명시적으로 켤 때만 listen. 켤 때 보안 경고 + 현재 LAN IP/포트 표시.
- **항상 인증**: 모든 REST/WS는 유효 JWT 필수(페어링 엔드포인트 제외, 그건 1회용 코드로 보호).
- **Origin/CORS 잠금**, **rate-limit**, **요청 본문 상한**, **감사 로그**(누가 무엇을 언제).
- **TLS**: LAN 자가서명 또는 터널 종단 TLS. v1은 토큰 기반 + 자가서명 옵션, 평문은 LAN 한정 경고.
- 포트 충돌 시 ephemeral fallback(기존 loopback.ts 패턴 재사용).

---

## 4. 인증 & 신원 (self-signup + Google/GitHub OAuth + device pairing)

> ⚠️ **이 절(Model A)은 사용자 D4 선택(Cloud relay)으로 대체됨 → 권위 설계는 `bridge-model-b-design.md` 참조.**
> 아래 Model A 설명은 히스토리/대안(LAN-only self-hosted)으로만 남긴다.

**모델 A(원안, self-hosted): PC가 신원 권위 + 폰은 페어링된 기기.**

### 4.1 소유자 계정(PC에 저장)
- `Account = { id, method: 'local'|'google'|'github', email?, displayName?, passwordHash?(scrypt), providerSub? }`
- **자체 회원가입**: email+password → scrypt 해시, safeStorage 암호화 저장. 첫 계정이 소유자.
- **Google/GitHub OAuth**: 기존 `oauth/flow.ts`(PKCE+loopback) 재사용. 단, *AI provider 토큰*이 아니라
  **사용자 신원**(`sub`/email)만 추출해 소유자 계정에 연결(`method='google'|'github'`).
- 단일 소유자 모델(개인 PC). 멀티유저는 비목표.

### 4.2 세션 = JWT
- 로그인 성공 → `accessToken`(단기, ~15m) + `refreshToken`(장기, 회전). 서명 시크릿은 PC가 생성해
  safeStorage 보관. 검증은 전부 main 안에서.

### 4.3 폰 페어링("동일 유저만 조작" 강제)
1. PC Settings에서 서버 ON → **QR** 표시: `{ url, pairingCode(1회용·90초), fingerprint }`.
2. 폰이 QR 스캔 → `POST /pair { code }` → PC가 코드 검증 후 **device 토큰**(장기, 취소가능) 발급.
3. 폰은 이후 그 토큰으로 접속. **권한 = 소유자에 귀속된 기기**. 즉 "PC 소유자가 물리적으로 승인한
   기기"만 조작 가능 → 사용자가 원한 "동일 유저" 보장을 *백엔드 없이* 충족.
4. (선택) 폰에서도 Google/GitHub 로그인 가능(UX/표시용). 조작 인가는 device 토큰이 근거.
5. **기기 관리 UI**(PC): 페어링된 기기 목록·마지막 접속·**취소(revoke)**.

> 인터넷 원격(T2/T3)·"폰에서 Google 로그인만으로 어디서나"가 핵심이면 **Model B(cloud authority)**:
> marudesk 클라우드가 계정·OAuth·relay 담당, 양쪽이 같은 클라우드 계정으로 로그인. UX는 가장
> "보통 앱"답지만 백엔드 구축·운영이 필수. **D4 ⚠️확정필요**에서 사용자 확인.

---

## 5. PC 원격 제어 (Electron이 PC를 조작)

새 `electron/pc-control.ts` + agent 도구(`agent/mcp/sources/pc.ts`). 전부 **gated(호출당 승인)** +
Settings **"PC Control" 권한**(기본 OFF) 뒤에. agent 루프가 호출하므로 *폰에서 지시→PC 조작*이 자연히 됨.

| 도구 | 동작 | 구현 | 위험 |
|---|---|---|---|
| `open_path(path)` | 파일/폴더를 기본 앱으로 열기 | `shell.openPath` | 중 |
| `open_external(url)` | 브라우저로 URL 열기 | `shell.openExternal`(기존 safe-open 스킴검증) | 저 |
| `reveal_in_explorer(path)` | 탐색기/Finder에서 위치 보기 | `shell.showItemInFolder` | 저 |
| `run_command(cmd, cwd?)` | 셸 명령 실행 | 새 PTY 세션 or `execFile`(allowlist/타임아웃) | **고** |
| `screenshot_desktop()` | 화면 캡처(“보기”) | `desktopCapturer` | 중(프라이버시) |
| `open_browser_tab(url)` | 앱 내장 브라우저 새 탭 | 기존 `browser:tabs-new` | 저 |

마우스/키보드 시뮬레이션·창 포커스 등 **풀 데스크톱 자동화**는 native 의존(nut.js 등) 필요 → 별도 phase.
v1은 위 표(사용자가 든 예시 충족)까지. 모든 호출은 감사 로그 + 승인 카드(기존 pendingApproval 재사용).

---

## 6. 모바일 클라이언트 (Capacitor APK + 디자인 확장)

- **공유 web client**: `mobile/src`가 PC 렌더러의 AgentChat/스토어를 재사용하되 `transport.ts`가
  invoke/emit를 HTTP+WS로 구현. 데스크톱 UI는 터치/모바일 비친화 → **반응형 모바일 쉘**(하단 탭,
  큰 터치 타깃, 키보드 회피, 스트리밍 캐럿/툴카드 재사용)을 새로 입힘.
- **화면**: ① Connect(QR 스캔/수동 URL) ② Login(자체/Google/GitHub) ③ Chat(메인) ④ Approvals(승인/질문)
  ⑤ Devices/Settings. "디자인·메뉴 확장"은 여기로 수렴.
- **Capacitor 플러그인**: Secure Storage(토큰), Camera/Barcode(QR), App/Deep Link, Push(후속), Network.
- **산출물**: `mobile/android` → **APK**(electron-builder와 별개 파이프라인). 같은 코드로 **PWA**도 무료.
- 네이티브 느낌(RN/Flutter) 선호 시 D6 변경 — **⚠️확정필요**.

---

## 7. ①DevTools / ②MCP 고도화 연계

- **②MCP**: (a) **정리/보완** — 중복 `terminal_output` 제거, `delete_session`/`delete_memory` 추가,
  gated/write 일관화(이번 라운드 진행). (b) **고도화** — 외부(stdio/remote) **MCP 커넥터**를
  기존 `registerMcpServer` 머지 지점에 실제 transport로 연결(루프 중재 유지 래퍼), Settings에서 추가/관리.
  (c) pc-control을 MCP 도구로 노출(§5).
- **①DevTools**: 포지셔닝 wedge("AI가 실행 중 앱을 본다")에 맞춰 **agent 쪽 런타임 컨텍스트**를 우선
  강화(예: console 전 레벨 미러, a11y/event-listener 읽기). 사람 패널의 Sources/Profiler 파리티는
  freeze 유지([[marudesk-positioning-wedge]]). 모바일에서도 "fix this" 런타임 루프가 그대로 돈다.

---

## 8. 마이그레이션 맵 (파일별)

**추가**: `electron/server/**`, `electron/pc-control.ts`, `electron/agent/mcp/sources/pc.ts`,
`shared/remote.ts`, `shared/pc-control.ts`, `src/features/server/**`(PC측 서버/기기 UI), `mobile/**`(신규 패키지).

**수정**:
- `electron/main.ts` — 서버 init(Settings 토글), pc-control 핸들러 등록.
- `shared/ipc.ts` — `server:*`(start/stop/status/qr/devices/revoke), `pc:*` 채널 추가.
- `electron/settings.ts` / `shared/settings.ts` — `server.enabled/port`, `pcControl.enabled`, 기기 목록.
- `electron/agent/mcp.ts` — 외부 MCP 커넥터 registry 실제화(②b), pc 소스 등록.
- `electron/secrets.ts` — JWT 시크릿·계정 해시·device 토큰 저장 키 추가.
- `src/.../AgentChat.tsx` 등 — transport 추상화 경계 정리(모바일 재사용 위해 IPC 직접참조 최소화).

**제거**: `terminal_output`(②a, 완료).

---

## 9. 단계 계획 (Phased roadmap)

| 단계 | 트랙 | 내용 | 결정의존 | 상태 |
|---|---|---|---|---|
| **M0** | ② | MCP 정리: `terminal_output` 제거, `delete_session/_memory` 추가, gated 일관화 | 무 | ✅ 완료 (커밋 `3ca37b9`, e2e 52) |
| **M1** | ⑤ | `pc-control.ts`(`open_path`/`open_external`/`reveal_in_explorer`) + MCP `pc` 그룹 + `pcControl` 권한(기본 OFF) + 호출당 승인 | 무 | ✅ 완료 (커밋 `3ca37b9`) |
| **M2** | ① | DevTools 런타임-컨텍스트 고도화: 전 레벨 console 캡처 + 에이전트 `read_console`(log/info/warning/error/debug 필터), 패널 파리티 freeze 유지 | 무 | ✅ 완료 — `extractConsoleMessage`(shared/runtime-evidence) + main-side `consoleBuffers`(state.ts) + `read_console` 툴; nav/delete에서 clear; 유닛 스펙 추가 |
| **M3** | ②b | 외부(stdio) MCP 커넥터: `@modelcontextprotocol/sdk` Client 직접 구동(auto-exec X)→gated `McpTool` 래핑(루프 중재 유지), `mcp-servers.json` + Settings 관리 UI, graceful failure/timeout/env-allowlist | 무 | ✅ 완료 — e2e 59, harness:mcp 34/34, dep `@modelcontextprotocol/sdk` |
| **M4** | ③ | `server/` 스캐폴드: **SSE+REST**(WS·새 의존성 없이 `node:http`만), agent:event 중계, 로컬 토큰만(인증 전 단계) | 무 | ✅ 스캐폴드 완료 — `electron/server/{index,router,token}.ts`+`shared/remote.ts`, **127.0.0.1 전용·기본 OFF·전 엔드포인트 Bearer 토큰(safeStorage, timingSafeEqual)**, `subscribeAgentEvents` 팬아웃, 헤드리스 하니스 16/16 (tsc/eslint 0, build, e2e 52/52). loop emit는 렌더러 push 유지 |
| **M5** | ④ | auth: 자체가입 + Google/GitHub(소유자) + JWT + **device pairing/QR** + 기기관리 UI | **D4** | ⚠️확인 |
| **M6** | ④ | `mobile/` Capacitor 앱: transport + 반응형 쉘 + Connect/Login/Chat → **APK 산출** | **D6** | ⚠️확인 |
| **M7** | ③ | 보안 하드닝(TLS/터널 문서, rate-limit, 감사), e2e/실기기 도그푸드 | 무 | |

M0~M4는 **결정 무관** → 바로 진행. M5 착수 직전에 D4·D6만 사용자 확인.

---

## 10. 보안 체크리스트 (서버를 여는 순간 필수)
- [ ] 서버 기본 OFF, 켤 때 경고 + 노출 IP/포트 명시
- [ ] 모든 엔드포인트 인증(JWT) — 페어링만 1회용 코드(만료·횟수 제한)
- [ ] device 토큰 취소 가능 + 기기 목록 UI
- [ ] rate-limit / 본문 상한 / Origin 검증 / 감사 로그
- [ ] pc-control·eval 등 위험 도구는 호출당 승인 + 권한 게이트
- [ ] 평문(TLS 없음)은 LAN 한정 + 경고, 인터넷 노출은 터널 권장
- [ ] 비밀(JWT 시크릿·계정 해시·토큰)은 safeStorage만, 렌더러/네트워크로 평문 유출 금지

### 10.1 M4 보안 리뷰 결과 (2026-06-01) + **M5(LAN 노출) 전 필수 차단 목록**
M4 서버 스캐폴드 보안 리뷰: **Critical 0 / High 0** (loopback-only 현 시점 LOW). 7개 요구사항
(127.0.0.1-only 바인드, 모든 라우트 auth-first + constant-time/length-guarded 비교, 본문 상한 선검사,
content-type 게이트, SSE cleanup, safeStorage 0600 토큰, 토큰 무로깅) 전부 통과. **즉시 수정 완료**:
SSE backpressure 가드(`writableNeedDrain` → 멈춘 클라가 main 메모리 OOM 못 시킴), bearer 정규식 RFC 완화.

**M5에서 LAN으로 바인드를 넓히기 직전 반드시 처리 (현재는 loopback이라 무해, 노출 순간 High 승격):**
- [x] **L-1 원격 self-approval 정책**: ✅ 해결 — bridge발 `approve`는 전부 `electron/server/dispatch.ts`를
      거치므로(데스크톱 IPC는 loop를 직접 호출, dispatch 미경유), 서버 노출 중 gated 도구의 원격 *승인*을 거부해
      gated 승인을 **데스크톱 UI에 고정**한다. 원격 *거부*는 fail-safe로 허용. 주입형 가드 `approval-guard.ts`
      (serverExposed=`enabled||cloudEnabled`, isGated=isGatedTool). 검증: harness:pair. (cf. t2 design §8)
- [ ] **L-2 Host 헤더 allowlist**(DNS-rebinding 차단): `127.0.0.1:<port>`/페어링된 호스트 외 거부.
- [ ] **M-2 요청 타임아웃**: `headersTimeout`/`requestTimeout`/`keepAliveTimeout` 설정(slowloris).
- [ ] **M-1+ SSE 동시 연결 상한**(예: ~4) — 백프레셔 가드는 완료, 연결 수 cap은 M5.
- [ ] (별건) Electron 메이저 업그레이드(현재 dev 프레임워크 advisory는 전부 local-vector, 이 서버로 도달 불가; prod deps 0 vuln).

## 11. Non-goals (v1)
- 멀티-유저/팀 계정, 조직 권한.
- 무설정 인터넷 원격(T3 cloud relay) — 터널로 우회.
- 풀 데스크톱 자동화(마우스/키보드/창 제어) — native robot 별도 phase.
- iOS 스토어 배포(코드 공유는 되나 빌드/서명 파이프라인은 후속).
