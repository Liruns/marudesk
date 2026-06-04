# marudesk — Provider 흡수 확장 **계획문서** (구독 OAuth + 카탈로그)

> 상태: **계획 (2026-06-04)** · 범위: 참고 레포 2종을 소스 분석해 **흡수할 provider를 리스트업**하고, 기존
> OAuth seam 위에 **단계적으로 추가**하는 로드맵.
> 부모 문서: [oauth-providers-design.md](./oauth-providers-design.md)(§9 config seam, §10 실험적 provider)
> 참고 구현: [nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent) ·
> [anomalyco/opencode](https://github.com/anomalyco/opencode)

---

## 0. 한 줄

지금 OAuth 구독 로그인은 4종(`anthropic` / `xai` / `openai-codex` / `google-caa`)이다. 참고 레포가
지원하는 provider를 흡수해 **구독 OAuth를 더 늘리고**(1차 = **GitHub Copilot**, **OpenRouter**), 덤으로
**API-키 built-in 카탈로그**를 넓힌다. 기존 [config seam](../electron/oauth/config.ts)(§9.2)이 이미
"config 엔트리 + driver" 한 벌이면 provider가 붙게 설계돼 있어, 대부분 **데이터 추가**다.

## 1. 동기

- 부모 문서 §9.2에서 만든 `OAuthProviderConfig`(데이터-드리븐 flow)는 **provider 추가 비용을 config 한
  벌로** 낮췄다. 그 seam을 실제로 더 쓰자는 게 이 계획의 핵심.
- 참고 레포가 **프로토콜을 이미 검증**해 둠 — 둘 다 GitHub Copilot/OpenRouter 관련 이슈·구현을 갖고
  있어(아래 §2 근거) 우리가 흐름을 새로 발명할 필요가 없다.
- 사용자 수요: "Claude/Grok 구독은 있는데 Copilot 구독도 있다", "OpenRouter 키 하나로 다 쓴다" — 둘 다
  **BYOK 마찰 제거**라는 부모 문서 동기와 같은 결.

## 2. 소스 분석 — 참고 레포가 제공하는 provider

> ⚠️ 두 레포는 fork/파생이라 일부는 공식 docs·이슈 트래커로 교차확인했다. 아래 분류의 핵심은
> **"모델 인증 OAuth"** 와 **"메신저 채널 OAuth"**, **"단순 API 키"** 를 구분하는 것 — 우리가 흡수할
> 가치는 앞의 둘 중 **모델 인증 OAuth**(와 카탈로그용 API 키)다.

### 2.1 anomalyco/opencode

- **auth 추상화**: `oauth` / `api` / `wellknown` 3종(`packages/opencode/src/auth/index.ts`).
- **provider별 커스텀 auth 로더**(`provider/provider.ts`의 `custom()`):
  `anthropic`, `openai`, `xai`, **`github-copilot`**, `azure`, `amazon-bedrock`, `google-vertex`,
  `gitlab`, `cloudflare-workers-ai`, `cloudflare-ai-gateway`, `sap-ai-core`.
- **구독 OAuth 로그인 실구현**: Anthropic(Claude Pro/Max), OpenAI(ChatGPT), **GitHub Copilot(device
  flow)**, xAI. + **OpenRouter OAuth PKCE** 지원(이슈 #7766).
- 그 외 models.dev/AI SDK로 **75+ provider** API 키, 자체 구독 **OpenCode Zen / Go**.

### 2.2 nousresearch/hermes-agent

- **모델/추론 provider(대부분 API 키)**: Nous Portal, OpenRouter(200+), OpenAI, Anthropic, NovitaAI,
  NVIDIA NIM(Nemotron), Hugging Face, Xiaomi MiMo, z.ai/GLM, Kimi/Moonshot, MiniMax, Custom.
- **GitHub Copilot**: 이슈 #16551·#11442·#7731에서 `copilot_internal/v2/token` 교환·enterprise
  endpoint·context window를 다룸 → **Copilot 구독 인증을 실제로 다룬다**.
- **로그인/메신저 게이트웨이 OAuth/봇토큰**: Nous Portal(OAuth), Telegram, Discord, Slack, WhatsApp,
  Signal, Email → **모델 인증이 아니라 채널 연동**이라 marudesk(데스크톱 에이전트) 범위 밖.

## 3. 흡수 후보 매트릭스

| provider | 인증 흐름 | API 다이얼렉트 | 흡수 난이도 | 우선순위 |
|---|---|---|---|---|
| **GitHub Copilot** | **device-code**(신규 flow) + Copilot 토큰 교환 | OpenAI 호환 `api.githubcopilot.com` + 특수 헤더 | 중(신규 flow 1종 + 토큰 swap) | **P0 — 구독 OAuth** |
| **OpenRouter** | OAuth **PKCE → API 키 교환**(loopback 재사용) | OpenAI 호환 `openrouter.ai/api/v1` | 하(loopback 결과를 키로 저장) | **P0 — 구독/통합 OAuth** |
| Groq | API 키 | OpenAI 호환 | 하(카탈로그만) | P1 — built-in |
| Cerebras | API 키 | OpenAI 호환 | 하 | P1 — built-in |
| Mistral | API 키 | OpenAI 호환(+ Mistral) | 하 | P1 — built-in |
| DeepSeek | API 키 | OpenAI 호환 | 하 | P1 — built-in |
| Moonshot / Kimi | API 키 | OpenAI 호환 | 하 | P2 — built-in |
| MiniMax | API 키 | OpenAI 호환 | 하 | P2 — built-in |
| NVIDIA NIM | API 키 | OpenAI 호환 | 하 | P2 — built-in |
| NovitaAI | API 키 | OpenAI 호환 | 하 | P2 — built-in |
| Vercel AI Gateway | API 키 | OpenAI 호환(멀티벤더) | 하 | P2 — built-in |
| Azure / Bedrock / Vertex / SAP AI Core | 클라우드 자격증명 | 벤더별 | 상(구독 OAuth 아님) | **비목표** |
| Nous Portal · Telegram · Discord · … | 채널 OAuth/봇토큰 | 모델 인증 아님 | — | **비목표** |

P1/P2(API 키)는 사실상 **이미 `custom:*` 커스텀 엔드포인트로 가능**하다 — built-in 승격은 "로고+시드
카탈로그+한 줄 hint"의 UX 개선이지 신규 메커니즘이 아니다. 진짜 엔지니어링은 **P0 둘**이다.

## 4. P0-A — GitHub Copilot (구독 OAuth, **신규 device-code flow**)

opencode/hermes 둘 다 같은 흐름. 부모 문서의 manual-paste/loopback과 **다른 콜백 전략**이라 `OAuthFlow`에
세 번째 값 `device-code`를 추가한다.

### 4.1 흐름 (device authorization grant, RFC 8628)

```
client_id = Iv1.b507a08c87ecfe98              # GitHub Copilot first-party App (vendor 공개값)
1) POST https://github.com/login/device/code      {client_id, scope:"read:user"}
     → {device_code, user_code, verification_uri, interval, expires_in}
2) UI: verification_uri(github.com/login/device) 를 열고 user_code 표시 → 사용자가 승인
3) interval 마다 POST https://github.com/login/oauth/access_token
     {client_id, device_code, grant_type:"urn:ietf:params:oauth:grant-type:device_code"}
     → authorization_pending 반복, 성공 시 {access_token = ghu_…}
4) **Copilot 세션 토큰 교환**:
     GET https://api.github.com/copilot_internal/v2/token   (Authorization: token ghu_…)
     → {token, expires_at, endpoints:{api:"https://api.githubcopilot.com"}}  # 단명 JWT, ~30분
```

### 4.2 비자명 요구 (없으면 4xx)

- **2단계 토큰**: `ghu_` GitHub 토큰(refresh 대신 재발급) → 호출 직전 `copilot_internal/v2/token`으로 **단명
  Copilot JWT** 교환. JWT는 `expires_at` 직전 재교환(부모 §9.2 `getValidAccessToken` 패턴 재사용 —
  여기선 "refresh" 대신 "re-exchange").
- **GitHub App user 토큰(`ghu_`)만** `copilot_internal` 교환을 받는다(OAuth App `gho_` 불가) → device
  flow client_id는 반드시 **Copilot App**(`Iv1.b507a08c87ecfe98`)이어야 함.
- **호출 헤더**(VS Code 모사): `Authorization: Bearer <copilot_jwt>`, `Copilot-Integration-Id`,
  `Editor-Version`, `Editor-Plugin-Version` 등. anthropic-beta/codex 헤더와 같은 패턴으로
  `config.ts`에 상수화.
- API는 `api.githubcopilot.com`(OpenAI 호환 `chat/completions`) → 드라이버/모델은
  `@ai-sdk/openai-compatible` 또는 `createOpenAI({ baseURL })`로 슬롯인.

### 4.3 모델링

- 신규 built-in `github-copilot`("GitHub Copilot"), `oauthOnly: true`(API 키 경로 없음 — opencode와
  동일). 구독 등급(Pro/Pro+/Business/Enterprise)이 모델 목록을 좌우 → `copilot_internal` 응답 또는
  `/models` 라이브 발견 권장(seed 카탈로그는 보수적으로).

## 5. P0-B — OpenRouter (OAuth **PKCE → API 키**, loopback 재사용)

콜백 캡처는 **기존 loopback 인프라 그대로**(부모 §9.2 `electron/oauth/loopback.ts`). 다른 점은 **교환
결과가 access/refresh 토큰이 아니라 장수명 OpenRouter API 키**라는 것.

```
1) authorize: https://openrouter.ai/auth?callback_url=<loopback>&code_challenge=<S256>
              &code_challenge_method=S256
2) loopback이 ?code=… 캡처
3) POST https://openrouter.ai/api/v1/auth/keys   {code, code_verifier}
     → {key = sk-or-…}                            # 사용자 소유 API 키
4) 그 키를 **secrets vault에 apiKey로 저장**(OAuth 토큰 블롭 아님 — refresh 없음)
5) 호출: createOpenAI({ baseURL:"https://openrouter.ai/api/v1", apiKey }).…  # 표준 OpenAI 호환
```

→ 토큰 만료/refresh 로직 불필요. `OAuthProviderConfig`에 **결과 처리 = `apiKeyExchange`** 변형을 한
종류 더 두면 끝(또는 별도 얇은 핸들러). built-in `openrouter`("OpenRouter"), 일반 provider(API 키 +
"Connect with OpenRouter" 둘 다 가능).

## 6. 아키텍처 (변경 맵 — 기존 seam에 얹기)

```
shared/providers.ts
  - BuiltinProviderId += 'github-copilot' | 'openrouter' (+ P1/P2 카탈로그 ids)
  - OAuthFlow += 'device-code'
  - PROVIDERS/MODELS += 신규 시드 카탈로그
electron/oauth/config.ts
  - GITHUB_COPILOT_OAUTH(flow:'device-code', deviceCodeUrl, copilotTokenUrl, 헤더 상수)
  - OPENROUTER_OAUTH(flow:'loopback', result:'api-key-exchange', keysUrl)
  - OAUTH_CONFIGS += 두 항목
electron/oauth/device-code.ts      ★신규 — RFC 8628 폴링(interval/expires/slow_down) + 취소
electron/oauth/flow.ts             - device-code 분기 + Copilot 토큰 re-exchange(getValidAccessToken 변형)
                                   - api-key-exchange 결과 처리(OpenRouter)
electron/oauth/handlers.ts         - start: device-code면 user_code/verification_uri 반환
electron/providers/github-copilot.ts ★신규 드라이버(listModels via copilot endpoint, Bearer)
electron/providers/openrouter.ts     ★신규 드라이버(listModels /api/v1/models)
electron/providers/index.ts        - DRIVERS += 두 항목(union 타입이 누락을 컴파일 에러로)
electron/agent/model.ts            - github-copilot: createOpenAI(githubcopilot baseURL)+헤더
                                   - openrouter: createOpenAI(openrouter baseURL)+apiKey
electron/agent/loop.ts             - Copilot 헤더/베타값 주입(anthropic 프리픽스와 같은 자리)
src/features/settings/ProviderOAuthConnect.tsx
                                   - phase에 'device' 추가: user_code 크게 표시 + "GitHub에서 열기"
src/features/providers/store.ts    - startOAuth가 device-code면 {userCode, verificationUri} 투영
e2e/oauth.spec.ts                  - github-copilot/openrouter 계약(device start·loopback start 미호출)
```

P1/P2 API-키 provider는 위에서 **`PROVIDERS`/`MODELS` 엔트리 + 드라이버 파일 + `DRIVERS` 등록**만 —
OAuth 변경 없음.

## 7. 단계 (phased)

1. **flow 일반화**: `OAuthFlow += 'device-code'`, `config.ts`에 결과 처리(`token` | `api-key-exchange`)
   추상화. flow.ts/handlers.ts 분기. (UI는 다음 단계)
2. **GitHub Copilot(P0-A)**: device-code.ts + Copilot 토큰 교환 + 드라이버 + model.ts/loop.ts 헤더 +
   ProviderOAuthConnect device phase.
3. **OpenRouter(P0-B)**: loopback + api-key 교환 + 드라이버. (UI는 기존 loopback 스피너 재사용.)
4. **API-키 built-in 일괄(P1/P2)**: Groq/Cerebras/Mistral/DeepSeek(+선택적으로 나머지) 시드 카탈로그
   + 드라이버. 로고는 `ProviderGlyph` 확장.
5. **검증**: `npm run typecheck` + e2e(계약/라운드트립) + 신규 flow 헤드리스 단위(device-code 폴링
   상태머신, api-key 교환 파싱) + **실 구독 dogfood**(Copilot/OpenRouter 계정).

## 8. 비목표 (이번 계획 밖)

- **Azure / Amazon Bedrock / Google Vertex / SAP AI Core**: 구독 OAuth가 아니라 클라우드 IAM/SigV4
  자격증명 — 별개의 큰 작업, 데스크톱 구독 동기와 어긋남.
- **Nous Portal / Telegram / Discord / Slack / WhatsApp / Signal**: 모델 인증이 아니라 **메신저 채널
  게이트웨이** — marudesk(데스크톱 에이전트) 범위 밖(mobile/relay와도 무관).
- **Hugging Face / Xiaomi MiMo 등 단발 API 키**: 필요 시 `custom:*` 커스텀 엔드포인트로 즉시 가능 —
  built-in 승격은 수요 보고 추후.

## 8.5 진행 상태 (2026-06-04)

- ✅ **P1/P2 API-키 built-in 5종 흡수 완료**: `openrouter` / `groq` / `cerebras` /
  `mistral` / `deepseek`. 구현 = `shared/providers.ts`(union+`PROVIDERS`+`MODELS`) +
  `electron/providers/openai-compatible.ts`(공용 드라이버 팩토리) + `DRIVERS` 등록 +
  `electron/agent/model.ts`(base URL + `buildModel` case) + `electron/models-dev.ts`
  (라이브 카탈로그 매핑). 글리프는 당분간 generic 모노그램(브랜드 마크는 후속).
  - 검증: `tsc -b` 클린 · eslint 클린 · 카탈로그 정합성(14 providers / 44 models / 0 문제) ·
    e2e `provider-catalog.spec.ts` 3/3 + 기존 oauth/agent/custom-providers 21/21.
- ⏭ **P0 구독 OAuth는 후속 PR**: GitHub Copilot(신규 `device-code` flow + 토큰 교환)·
  OpenRouter PKCE(키 교환)는 **실 구독 계정 없이는 라이브 검증 불가**하고 신규 flow/IPC 표면
  변경이 커서, 안정적인 API-키 흡수분을 먼저 머지하고 별도로 진행한다(§9 위험 참고).

## 9. 위험 / 주의

- **vendor 내부값 회전**: Copilot client_id(`Iv1.…`)·`copilot_internal/v2/token`·Editor 헤더,
  OpenRouter `/api/v1/auth/keys`는 비공식/회전 가능 — 부모 문서 §6처럼 실패 메시지에 안내하고 dogfood로
  확인.
- **Copilot ToS**: 비-에디터 클라이언트의 Copilot API 사용은 GitHub ToS 회색지대일 수 있음 — opencode가
  공식 통합(2026-01 changelog)으로 합법화된 경로인지, 우리는 어느 client_id를 쓸지 **구현 전 확정** 필요.
  (공식 통합 client가 있으면 그쪽 우선.)
- **단명 Copilot JWT**(~30분): 긴 에이전트 턴 중 만료 가능 → 턴 시작뿐 아니라 **호출 직전 유효성** 확인.
- **실계정 미검증**: 모든 신규 provider는 부모 §10.4와 동일하게 **실 구독 dogfood 전까지 experimental**
  표기.
