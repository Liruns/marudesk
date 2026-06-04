# marudesk — AI Provider **OAuth 연결** 설계 (구독 로그인)

> 상태: **설계+구현 (2026-05-31)** · 범위: API 키 없이 **OAuth(구독)로 AI 사용** — 1차 타깃 **Anthropic Claude**(Pro/Max 구독)
> 참고 구현: [nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent) (`agent/anthropic_adapter.py` 등) 분석
> 동반: [agentic-chat-v2 설계](./agentic-chat-v2-design.md)(provider/model 레이어) · [roadmap](./roadmap.md)

---

## 0. 한 줄

지금은 provider별 **API 키(BYOK)** 만 받는다. 여기에 **OAuth 구독 로그인**을 더해, 사용자가 **Claude Pro/Max 구독으로 그대로** 에이전트를 돌릴 수 있게 한다 — 결제 크레딧이 있는 API 키 없이 **dogfooding 마찰 제거**가 핵심 동기다([agentic-chat 메모: "아직 실 LLM 키로 dogfood 안 됨"]).

## 1. 동기

- 에이전트 v2는 완성됐지만 **실 키로 돌려본 적이 없다.** 가장 큰 마찰: "크레딧 있는 API 키"가 있어야 한다는 것.
- 많은 사용자가 **Claude.ai 구독(Pro/Max)** 은 있어도 **API 크레딧**은 없다. OAuth 구독 로그인은 이 갭을 정확히 메운다 — 키 발급/결제 없이 "Claude로 로그인 → 끝".
- hermes-agent가 4개 provider(Anthropic/Google/OpenAI/xAI)를 OAuth로 붙이는 코드를 갖고 있어, **프로토콜 메커니즘이 검증돼 있다**(언어는 Python이지만 흐름은 그대로 이식).

## 2. 결정 요약

1. **1차 타깃 = Anthropic Claude OAuth만.** 가장 단순(서버 없는 manual-paste PKCE)하고 보상이 가장 큼. AI SDK에 **그대로 슬롯인**(아래 §5).
   - OpenAI(ChatGPT `backend-api/codex` **Responses** 다이얼렉트 + JWT 파생 account-id 헤더)·Google(Code-Assist `loadCodeAssist`/`onboardUser` 봉투)은 **완전히 다른 API 표면**이 필요 → **비목표(이번 범위 밖)**. 정적 카탈로그/BYOK 경로는 그대로 둠.
2. **Manual-paste PKCE 플로우.** redirect_uri = Anthropic 호스팅 콜백 페이지(`console.anthropic.com/oauth/code/callback`)가 `code#state` 를 보여주고 → 사용자가 복사 → marudesk에 붙여넣기. **로컬 루프백 서버/커스텀 프로토콜 등록 불필요**(포트/방화벽 footgun 회피). 데스크톱 GUI에서 가장 견고.
3. **first-party CLI(Claude Code) 공개 client_id 재사용** — 구독 과금을 여는 load-bearing 값. (hermes와 동일: `9d1c250a-…`.)
4. **토큰은 기존 암호화 vault에 저장**([electron/secrets.ts](../electron/secrets.ts) safeStorage). provider별 creds 레코드에 `oauth` 블롭을 **apiKey 옆에** 추가. 만료 전 **proactive refresh**(skew 60s, 동시-refresh dedup).
5. **모든 OAuth 로직은 main 프로세스.** 에이전트 루프가 이미 main(Node fetch)이라 CSP 무관, 토큰이 렌더러에 노출되지 않음.
6. **확장 seam은 두되 over-build 금지.** OAuth provider는 `{ clientId, scopes, authorizeUrl, tokenUrls, redirectUri }` config 객체로 기술 → 나중에 xAI(루프백) 추가가 config + 콜백 전략 한 줄. 단 이번엔 **루프백 인프라는 만들지 않음.**

## 3. hermes-agent 분석 — Anthropic 흐름 (이식 대상)

`agent/anthropic_adapter.py` 기준. **Claude Pro/Max 구독**으로 로그인해, 일반 Anthropic Messages API를 `x-api-key` 대신 **Bearer 토큰**으로 호출한다.

```
client_id    = 9d1c250a-e61b-44d9-88ed-5944d1962f5e   # Claude Code의 공개 client
scopes       = org:create_api_key user:profile user:inference
redirect_uri = https://console.anthropic.com/oauth/code/callback   # manual-paste
authorize    = https://claude.ai/oauth/authorize?code=true&client_id=…&response_type=code
               &redirect_uri=…&scope=…&code_challenge=<S256>&code_challenge_method=S256&state=…
token        = https://console.anthropic.com/v1/oauth/token   (platform.claude.com fallback)
```

- **PKCE S256.** `state` 도 같이 보냄(CSRF). 콜백 페이지는 `code#state` 를 표시 → `split('#')` 로 분리, state 검증.
- **토큰 교환(JSON body):** `{grant_type:"authorization_code", client_id, code, state, redirect_uri, code_verifier}`.
- **refresh(JSON body):** `{grant_type:"refresh_token", client_id, refresh_token}`. 응답: `{access_token, refresh_token, expires_in}`.
- **호출 시 3가지 비자명 요구**(없으면 401/422):
  1. `Authorization: Bearer <access_token>` (NOT `x-api-key`)
  2. `anthropic-beta: claude-code-20250219,oauth-2025-04-20`
  3. system 프롬프트가 **`"You are Claude Code, Anthropic's official CLI for Claude."`** 로 시작해야 함.

## 4. AI SDK 적합성 (핵심 발견)

`@ai-sdk/anthropic`(설치본 v3)이 **Bearer 인증을 1급 옵션으로** 지원 → 커스텀 fetch 불필요.

```ts
// node_modules/@ai-sdk/anthropic/dist/index.d.ts:1153-1163
apiKey?:    string;  // → x-api-key 헤더
authToken?: string;  // → Authorization: Bearer 헤더   ← 우리가 쓸 것
headers?:   Record<string,string>;  // → anthropic-beta 주입
// 5812: apiKey와 authToken 둘 다 주면 에러 (배타적)
```

→ OAuth 모델은 `createAnthropic({ authToken, headers: { 'anthropic-beta': OAUTH_BETA } })(modelId)`. (3)의 system 프리픽스는 [loop.ts](../electron/agent/loop.ts)에서 anthropic+oauth일 때 SYSTEM_PROMPT 앞에 prepend.

## 5. 아키텍처 (변경 맵)

```
shared/providers.ts        + OAuthTokens 타입, ProviderDef.oauth?(지원 플래그),
                             ProviderStatus.oauth?(연결됨), AGENT system 프리픽스 상수
electron/oauth/anthropic.ts  ★신규 — provider config + PKCE/authorizeURL/exchange/refresh
                             + getValidAccessToken(만료 refresh, dedup) + verifyAccess
electron/oauth/handlers.ts   ★신규 — auth:oauth-* 핸들러(start/complete/disconnect),
                             pending PKCE(verifier/state) main-메모리 보관(TTL 10분)
electron/secrets.ts          + CredEntry.oauth, get/set/clearProviderOAuth, listProviders에 oauth 반영
electron/agent/model.ts      buildModel(provider, modelId, auth: ModelAuth, baseUrl?)
                             — anthropic+oauth → authToken + beta 헤더
electron/agent/loop.ts       startTurn: auth 해석(oauth 우선) → ModelAuth; runLoop: system 프리픽스
electron/models.ts           anthropic+oauth만 있을 때 정적 카탈로그 반환(드라이버 시그니처 불변)
electron/main.ts             registerOAuthHandlers() 등록
shared/ipc.ts                + CHANNELS.auth, IpcMap 3채널
src/features/providers/store.ts   + startOAuth/completeOAuth/disconnectOAuth, oauth 상태 투영
src/features/settings/ProvidersSettings.tsx   Anthropic 카드에 "Connect with Claude" 섹션
e2e/oauth.spec.ts            ★신규 — IPC 계약·state 검증·disconnect 라운드트립(실 OAuth는 CI 불가)
```

### 5.1 인증 해석 (`ModelAuth`)
```ts
type ModelAuth =
  | { mode: 'api-key'; apiKey: string }
  | { mode: 'oauth'; accessToken: string };
```
`startTurn`: provider가 oauth 연결돼 있으면 `getValidAccessToken`(필요시 refresh) → `{mode:'oauth'}`. 아니면 기존 apiKey 경로. **oauth가 apiKey보다 우선**(둘 다 있으면).

### 5.2 IPC
```
auth:oauth-start      (provider) → { url }       # PKCE 생성·pending 저장·외부 브라우저 오픈
auth:oauth-complete   (provider, pasted) → bool  # code#state | 콜백URL | code 파싱·교환·저장·검증
auth:oauth-disconnect (provider) → bool          # 토큰 폐기
```
연결 상태는 기존 `secrets:list-providers`(ProviderStatus.oauth)로 노출 — 신규 status 채널 불필요.

## 6. 보안

- 토큰은 **safeStorage 암호화 vault**(apiKey와 동일), 평문 디스크 기록 없음.
- PKCE `state` CSRF 검증, pending은 main-메모리 + TTL.
- authorize URL은 `https:` 만 → 기존 [safe-open.ts](../electron/safe-open.ts) 통과(허용 스킴).
- client_id/beta 날짜 문자열은 **vendor 내부값**이라 회전 가능 → 구현 시 동작 검증, 실패 메시지에 안내.

## 7. 비목표 (이번 범위 밖)

- OpenAI/Google/xAI OAuth (다른 API 다이얼렉트 — §2.1). 루프백 콜백 서버. 커스텀 프로토콜(`marudesk://`) 등록.
- OAuth로 받은 토큰으로 `/v1/models` 동적 카탈로그(정적 카탈로그로 충분 — Claude 4.x는 고정).

## 8. 단계

1. 코어: shared 타입 + secrets 확장 + oauth/anthropic.ts (PKCE/교환/refresh/검증)
2. 모델 배선: model.ts(ModelAuth) + loop.ts(해석 + system 프리픽스)
3. IPC: ipc.ts 채널 + oauth/handlers.ts + main.ts 등록
4. 렌더러: store + ProvidersSettings UI
5. 검증: `rtk tsc` 빌드 + e2e(계약/라운드트립) + 실 구독 dogfood(수동)

---

## 9. 다중 provider 확장 (2026-06-01) — xAI Grok 추가 + loopback 인프라

§2.6에서 예고한 seam을 실현해 **Claude 외 provider**로 확장한다. 1차 추가 = **xAI Grok**.

### 9.1 provider별 난이도 (재확인)
| provider | OAuth 흐름 | API 호출 | 판정 |
|---|---|---|---|
| **xAI Grok** | loopback PKCE (`auth.x.ai`) | xAI `api.x.ai/v1` **Responses API** + 평범한 Bearer | ✅ **추가** (깨끗) |
| OpenAI (ChatGPT) | device/loopback | `chatgpt.com/backend-api/codex` **Responses 다이얼렉트** + JWT 파생 `ChatGPT-Account-ID` | ⛔ 보류 |
| Google (Gemini) | loopback PKCE | `cloudcode-pa.googleapis.com/v1internal` **Code-Assist 봉투** + project 부트스트랩 | ⛔ 보류 |

OpenAI/Google의 OAuth 토큰은 **구독 전용 백엔드(codex / code-assist)에만** 유효하다(표준 `api.openai.com` / `generativelanguage.googleapis.com` 아님). 둘 다 비표준·비문서·AI SDK에 안 맞고, 실계정 없이는 검증 불가 → **이번 범위 밖**(§7 유지). xAI는 표준 API라 Bearer 인증은 그대로 쓰되, 에이전트 호출은 이미지 입력을 위해 `@ai-sdk/xai` Responses API provider를 탄다.

### 9.2 일반화 (config + 두 콜백 전략)
- **callback 전략 2종**: `manual-paste`(Anthropic) | `loopback`(xAI). `OAuthFlow` 타입(shared)으로 표현, 렌더러가 분기.
- **`OAuthProviderConfig`(electron/oauth/config.ts)** 가 provider별 차이를 **데이터**로: `flow`, `tokenEncoding`('json'|'form'), `authorizeExtras`(anthropic `code=true` / xai `plan=generic,referrer`), `useNonce`(xai), `sendStateInTokenExchange`(anthropic), `echoChallengeInTokenExchange`(xai #26990 워크어라운드), `requireState`. flow 로직(electron/oauth/flow.ts)은 분기 없이 config를 읽음.
- **loopback 서버(electron/oauth/loopback.ts)**: `127.0.0.1`만 바인드(방화벽 프롬프트 없음), preferred 포트(xai 56121)→실패 시 ephemeral(0)로 폴백 + **바인드된 포트로 redirect_uri 재구성**(RFC 8252). 콜백 결과는 **생성 시점 promise로 캡처**(start→complete IPC 갭 사이 콜백이 와도 유실 없음 — race-free). first-wins, keep-alive 소켓 추적 후 close.
- **IPC**: `auth:oauth-start → {flow,url}`(loopback이면 서버도 띄움), `auth:oauth-complete({provider,pasted?})`(loopback은 pasted 무시하고 서버 콜백을 await, ~3분 타임아웃), **`auth:oauth-cancel`(신규 — loopback 대기 중단)**, `auth:oauth-disconnect`.

### 9.3 파일 (restructure)
```
electron/oauth/anthropic.ts  → 삭제(분해)
electron/oauth/config.ts     ★ OAuthProviderConfig + ANTHROPIC_OAUTH + XAI_OAUTH + 헬퍼/상수 + parsePastedCode
electron/oauth/flow.ts       ★ PKCE/authorizeURL/exchange/refresh/getValidAccessToken (config-driven)
electron/oauth/loopback.ts   ★ 임시 127.0.0.1 콜백 서버
electron/oauth/handlers.ts     start/complete/cancel/disconnect (flow 분기)
shared/providers.ts            BuiltinProviderId += 'xai'; PROVIDERS/MODELS += grok-4/3/3-mini/code-fast-1; OAuthFlow
electron/providers/xai.ts    ★ 드라이버(listModels, Bearer) + DRIVERS 등록
electron/agent/model.ts        buildModel `xai` case → createXai(api.x.ai/v1, Bearer).responses(...)
src/.../providers/store.ts     startOAuth→{flow,url}, completeOAuth(pasted?), cancelOAuth
src/.../settings/ProvidersSettings.tsx  OAuthConnect = flow 분기(manual paste / loopback 스피너+Cancel) + provider-generic 카피
e2e/oauth.spec.ts              xai 계약(start 미호출 — 포트/브라우저 side-effect 회피)
```
검증: tsc 클린 · e2e **47/47** · loopback race 수정(생성-시점 promise).

### 9.4 남은 것 / 주의
- xAI **403 = tier-gating**(grant은 정상)이라 refresh 실패로 토큰을 지우지 않음; 400/401만 지움.
- xAI client_id(grok-cli)·`plan=generic`은 vendor 내부값 — 회전 가능.
- ⚠️ xAI도 **실 계정 dogfood 미완**(e2e는 브라우저를 띄우는 loopback start를 호출하지 않음).
- OpenAI/Google은 사용자가 원하면 별도로 (codex Responses / code-assist 봉투) 추진 — 큰 작업.

---

## 10. OpenAI(ChatGPT) + Google(Gemini) OAuth (2026-06-01) — **실험적**

사용자 요청으로 §9.1에서 보류했던 둘을 추가. **구독 전용 백엔드**라 표준 API와 다르고 실계정 없이는 검증 불가 → **experimental**로 명시. 검증된 프로토콜(openai/codex Rust, gemini-cli 소스 교차확인)에 충실히 구현.

### 10.1 모델링 — 별도 provider
API-key `openai`/`google`와 **다른 백엔드/모델/요청 형식**이라 **별도 provider id**로 분리(hermes도 `openai-codex` 분리): `openai-codex`("OpenAI (ChatGPT)"), `google-caa`("Google (Gemini account)"). 둘 다 `ProviderDef.oauthOnly`(API 키 경로 없음 — 설정은 "Connect"만, 에이전트는 OAuth 필수). 기존 `openai`/`google` API-key provider는 불변.

### 10.2 OpenAI Codex
- OAuth: **loopback PKCE** `auth.openai.com`, client `app_EMoamEEZ73f0CkXaXp7hrann`, scope `openid profile email offline_access api.connectors.read api.connectors.invoke`, redirect `http://localhost:1455/auth/callback`(포트 1455→1457, **ephemeral 불가** — 클라이언트 allowlist), authorize에 `id_token_add_organizations=true`+`codex_cli_simplified_flow=true`+`originator=codex_cli_rs`. **교환=form, refresh=JSON**(비대칭 — `refreshTokenEncoding`). refresh는 refresh_token **회전**.
- account id: access_token JWT claim `["https://api.openai.com/auth"].chatgpt_account_id` (`electron/oauth/jwt.ts`).
- 호출: `createOpenAI({ baseURL:'https://chatgpt.com/backend-api/codex', apiKey:accessToken, headers:{chatgpt-account-id, originator, user-agent} }).responses(model)`. loop.ts가 `providerOptions.openai.store=false` + **max_output_tokens 생략**(codex 백엔드 요구). `OpenAI-Beta` 불필요(소스에 없음).
- 모델 id: ⚠️ **검증 불가**(hermes는 가공의 gpt-5.5 등; cutoff 이후). seed=gpt-5-codex/gpt-5, 실제론 `GET /backend-api/codex/models` 라이브 발견 권장.

### 10.3 Google Code-Assist
- OAuth: loopback PKCE, gemini-cli **공개 client_id+client_secret**(데스크톱 — 비밀 아님), scope `cloud-platform … userinfo.email userinfo.profile`, redirect `http://127.0.0.1:8085/oauth2callback`, `access_type=offline`+`prompt=consent`. 교환/refresh form+`client_secret`. Google는 보통 refresh_token **비회전**(없으면 기존 유지 — `tokensFrom`).
- 호출: 표준 Gemini API가 아니라 **Code-Assist**(`cloudcode-pa.googleapis.com/v1internal`). **`@ai-sdk/google`에 커스텀 `fetch` 주입**(`electron/oauth/google-code-assist.ts`)으로 변환: SDK가 만든 `…/models/{m}:generateContent`(또는 `:streamGenerateContent?alt=sse`)를 가로채 → `{project,model,user_prompt_id,request}` 봉투로 감싸 CAA에 POST → 응답 `{response}` 언랩(스트림은 SSE 청크별 언랩). project는 `loadCodeAssist`→`onboardUser`(LRO 폴링) 부트스트랩으로 1회 획득 후 토큰별 캐시. `MARUDESK_CAA_BASE_URL` env로 base override(테스트/프록시).

### 10.4 검증 + 한계
- tsc 클린 · **e2e 49/49**(openai-codex/google-caa 계약 — loopback start 미호출).
- **Code-Assist 변환 로직을 mock 백엔드로 헤드리스 4/4 검증**(`node --experimental-strip-types`: 봉투 wrap+unwrap / SSE unwrap / onboard 부트스트랩 / JWT account-id). loopback 서버 7/7도 유지.
- ⚠️ **실 ChatGPT/Google 계정 dogfood 필수** — 라이브 라운드트립(특히 codex Responses 바디 세부·CAA SSE 프레이밍)은 미검증. codex 모델 id·`OpenAI-Beta`·CAA 헤더/LRO는 회전/변동 가능.

---

## 11. 다중 provider 흡수 확장 — 계획 (2026-06-04)

§9.2의 config seam을 더 활용해 참고 레포(hermes-agent / opencode)가 지원하는 provider를 흡수하는
로드맵은 별도 계획문서로 분리했다 → **[provider-expansion-plan.md](./provider-expansion-plan.md)**.

- **P0 구독 OAuth 신규**: GitHub Copilot(신규 `device-code` flow + Copilot 토큰 교환),
  OpenRouter(OAuth PKCE → API 키 교환, loopback 재사용).
- **P1/P2 API-키 built-in 카탈로그**: Groq / Cerebras / Mistral / DeepSeek / Moonshot(Kimi) /
  MiniMax / NVIDIA NIM / Novita / Vercel AI Gateway.
- **비목표**: Azure/Bedrock/Vertex/SAP(클라우드 IAM), Nous Portal/Telegram/Discord 등(메신저 채널).
