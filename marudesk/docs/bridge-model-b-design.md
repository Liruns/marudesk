# Bridge — Model B (cloud relay) design

> 작성: 2026-06-01. **사용자가 D4에서 "Cloud relay (anywhere, no setup)" 선택** → 원래
> `remote-mobile-bridge-design.md` §4의 **Model A(PC 단독 권위 + device pairing)를 대체**한다.
> 이 문서가 브리지(M5/M6)의 권위 설계다. M0~M4(MCP 정리·PC 제어·DevTools·서버 스캐폴드)는 완료;
> M4의 전송/agent-중계 계층은 여기서 그대로 재사용된다.

---

## 1. 토폴로지 (왜 cloud relay가 "어디서나"를 푸는가)

NAT/방화벽 뒤의 PC에 폰이 직접 들어오려면 포트포워딩·터널이 필요하다(Model A의 한계). **Model B는
PC와 폰이 둘 다 클라우드로 *아웃바운드* 연결**해서 그 문제를 없앤다:

```
  PC (Electron, 호스트)                  Cloud (marudesk-relay, 사용자 호스팅)              Phone (Capacitor)
  ─ 로그인(같은 계정) ───────▶  ┌──────────────────────────────┐  ◀─────── 로그인(같은 계정) ─
  ─ WS 아웃바운드 connect ───▶  │  auth: 계정/OAuth/JWT          │  ◀──── WS 아웃바운드 connect ─
  ─ "이 계정의 host 등록" ───▶  │  relay: 같은 계정의 host↔client │                              
                                │         메시지 브로커(dumb pipe) │                              
  ◀── agent 명령 forward ──────│                                │ ──── agent 명령(send/…) ────▶
  ─── agent:event forward ────▶│                                │ ◀─── agent:event 스냅샷 ──────
                                └──────────────────────────────┘
```

- **PC = host**: 클라우드에 로그인 → 아웃바운드 WS 유지 → "계정 X의 host"로 등록.
- **Phone = client**: 같은 계정으로 로그인 → 클라우드가 그 계정의 host로 메시지를 중계.
- **Relay는 멍청한 파이프 + 인증/계정 서비스.** agent 로직·자격증명·워크스페이스·CDP는 전부 PC에 남는다
  (relay는 평문 페이로드를 보관하지 않음 — 종단 PC↔phone, relay는 포워딩만; 가능하면 E2E 암호화 후속).
- **"동일 로그인 유저만 조작"**: 클라우드가 강제 — host와 client가 *같은 계정*일 때만 브로커한다.

## 2. 인증 & 계정 (Model B — 클라우드가 권위)

- **계정 저장 = 클라우드 DB**(사용자 호스팅). `Account{ id, method:'local'|'google'|'github', email, passwordHash?(argon2/scrypt), providerSub?, createdAt }`.
- **자체 회원가입**: email+password → 서버 해시 저장.
- **Google/GitHub OAuth**: 표준 **web** 플로우(클라우드의 `/auth/{google,github}/callback` redirect). PC의
  기존 loopback PKCE(provider 로그인)와 달리, 여기선 클라우드가 OAuth client → 등록된 redirect URI 필요.
- **세션 = JWT**(access 단기 + refresh 회전), 클라우드 시크릿 서명. PC·폰 둘 다 같은 계정으로 로그인 →
  "same user". host 등록·client 접속 모두 JWT 필수.
- **기기 관리**: 계정에 연결된 host/clients 목록 + revoke(클라우드 측).

## 3. 프로토콜 (M4 재사용)

- M4의 **명령/스냅샷 shape**(`/agent/send|abort|respond|approve|reset`, `AgentChatState` 스냅샷,
  `shared/remote.ts`)을 **relay WS 메시지의 페이로드로 그대로** 사용. REST→WS 프레임으로 감싼다.
- PC는 relay WS로 받은 명령을 기존 loop 함수(`startTurn`/…, M4와 동일)로 실행하고, `subscribeAgentEvents`
  스냅샷을 relay로 push → 폰이 받는다(= "어디서나 같은 세션", 멀티-헤드).
- M4의 단일 bearer-token → **클라우드 발급 JWT**로 대체. localhost/LAN 직결(M4) 모드는 dev/오프라인용으로 유지.

## 4. ⚠️ 사용자가 제공해야 하는 외부 의존성 (코드만으론 못 끝나는 부분)

내가 **코드는 다 짤 수 있지만** 다음은 배포/등록이라 사용자(또는 사용자가 정한 호스팅)가 해야 한다:

1. **Relay 호스팅** — 작은 VPS / Fly.io / Render / Railway / Cloudflare 등 + **도메인**(OAuth redirect·TLS용).
2. **Google OAuth 앱** (Google Cloud Console) — client id/secret + 승인된 redirect URI(`https://<도메인>/auth/google/callback`).
3. **GitHub OAuth 앱** (GitHub → Developer settings) — client id/secret + callback URL.
4. **Android 빌드 툴체인** — APK 산출에 JDK + Android SDK/Gradle(또는 Android Studio) 필요. **웹 클라이언트·
   Capacitor 프로젝트는 내가 빌드/검증 가능**하지만 *서명된 APK 패키징*은 이 툴체인이 있어야 한다.
5. **JWT 서명 시크릿** — 클라우드가 생성·보관(코드로 처리).

→ 그 전까지 **로컬에서 전부 dev 구동 가능**: relay를 localhost로 띄우고 PC·웹클라이언트가 거기에 붙어
end-to-end 검증. 호스팅·OAuth 앱·Android SDK는 "실배포/실APK" 시점에만 필요.

## 5. 단계 계획 (Model B 브리지)

| 단계 | 내용 | 자율 빌드 가능? | 외부 의존 |
|---|---|---|---|
| **B1** | `relay/` 백엔드 코드: accounts·signup/login·Google/GitHub OAuth·JWT·host 등록·phone↔host 브로커(WS). localhost 구동 + 헤드리스 테스트 | ✅ 코드+로컬테스트 | 실배포=호스팅 |
| **B2** | PC connect-out 클라이언트: relay로 아웃바운드 WS, host 등록, M4 loop 브리지 재사용. Settings에 "Cloud account" 로그인 + 연결 상태 | ✅ (localhost relay 대상) | — |
| **B3** | 모바일 Capacitor 앱: 공유 web client(AgentChat 재사용) + WS transport + 화면(Connect/Login[자체+Google+GitHub]/Chat/Approvals) + 반응형 쉘 | ✅ 웹/PWA 빌드·검증 | APK=Android SDK |
| **B4** | OAuth 앱 연동(실 client id/secret) + relay 배포 + 도메인/TLS | 코드 ✅ | 호스팅·OAuth 등록 |
| **B5** | 하드닝(rate-limit/감사/E2E암호화 검토) + 실기기 도그푸드 | 부분 | 실환경 |

**즉시 시작 가능(호스팅·creds 없이)**: B1(relay 코드+로컬테스트) → B2(PC 연결) → B3(모바일 웹클라이언트).
이 3개로 **localhost에서 폰-웹 ↔ relay ↔ PC end-to-end가 도는 dev 데모**까지 자율로 만들 수 있고, 그 다음
사용자가 호스팅+OAuth 앱+Android SDK를 붙이면 실서비스/실APK가 된다.

## 6. 보안 (relay를 여는 순간)
- 모든 relay 엔드포인트 JWT 필수; signup/login·OAuth만 예외(자체 rate-limit).
- host↔client는 **같은 계정**만 브로커(서버 강제). relay는 페이로드 비저장; E2E 암호화는 후속 강화.
- `remote-mobile-bridge-design.md` §10.1의 M5 항목(Host allowlist·요청 타임아웃·원격 self-approval 정책)은
  여기서도 적용 — 특히 **원격(폰) self-approval**: gated 도구 승인을 폰에서 할지/PC-UI 고정할지 B-단계에서 확정.
- 비밀(계정 해시·JWT 시크릿·OAuth secret)은 서버에만; 클라이언트로 평문 유출 금지.

### 6.1 B1 보안 리뷰 결과 (2026-06-01) — fix-now vs 배포 전(deferred)
relay 보안 리뷰: **Critical 0.** 핵심 crypto는 견고 검증됨 — hand-rolled HS256 JWT(alg:none/swap 차단·exp 강제·constant-time sig), constant-time 비교, scrypt+salt 패스워드, **same-account WS 브로커 격리**, 사용자 열거 방지(dummy-verify). 위험은 crypto가 아니라 **상태성·배포 자세**에 집중.

**즉시 수정(B1 fix 라운드 — 코드 적용):** H1 refresh-jti를 계정당 **Set**으로(다중 세션=멀티-헤드 지원, 일회용 회전) + M1 `/auth/logout`; H3 ephemeral 시크릿 + (public bind | production)이면 **起動 거부** + 제공 시크릿 `<32B` 거부; M2 Google `email_verified` 필수(계정 탈취 방지); M5 토큰 응답 `Cache-Control: no-store` + `nosniff`/`Referrer-Policy`; M6 WS 업그레이드 rate-limit + Origin allowlist.

**배포 전 필수(deferred — 실인프라 필요, dev엔 무해):**
- [ ] **H2** refresh/CSRF-state/rate-limit를 **공유 저장소(DB/Redis)**로 (현재 in-process → 재시작 시 리셋·다중 인스턴스 불가). file `AccountStore`→실 DB와 같은 경계에서.
- [ ] **M3** TLS-종단 프록시 뒤에선 **신뢰 프록시 XFF**로 client IP 산출(현재 socket IP → 프록시 1버킷으로 붕괴).
- [ ] **M4** OAuth 콜백이 토큰을 네비게이션 본문으로 반환 → **앱 deep-link + 1회용 code 교환**으로 변경(모바일 클라 B3 인증 플로우와 결합 → B3에서 처리).
- [ ] **tokenEpoch** 계정 단위 일괄 무효화(분실/탈취 대응) + 짧은 refresh TTL 검토.
- [ ] Lows: 계정당 peer 상한, 브로커 무파싱(E2E 대비), 감사 로그, 패스워드 breach 체크.

배포(B4) 전 위 목록을 클리어한다.

## 7. 비목표(이번 라운드)
- marudesk 자체 호스팅 SaaS 운영(사용자가 self-host). 멀티테넌시·팀.
- E2E(end-to-end) 암호화는 설계만 — 1차는 relay-비저장 + TLS.
- iOS 스토어 배포.
