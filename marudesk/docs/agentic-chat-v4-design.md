# Agentic Chat v4 — Provider/Model UX + On‑demand Context (MCP‑style)

> 이 문서는 [agentic-chat-v3-ui-design.md](./agentic-chat-v3-ui-design.md)의 후속이다.
> v3가 *구조*(reasoning 블록, full‑surface `agent` 탭)를 깔았다면, v4는 두 가지를 끝낸다:
> **(A) 모델/프로바이더 선택 UX를 Claude/Codex Desktop 수준으로**, **(B) 탭 컨텍스트를
> opencode식 on‑demand 도구 레이어로** 옮긴다. 외부 MCP 서버 연결은 그다음 단계로 둔다.
>
> 작성: 2026-06-01. 확정된 방향: **A=커맨드 팔레트 피커**, **B=in‑process 컨텍스트
> 툴부터(외부 MCP는 future)**, **구현 순서=A 먼저**.

---

## 0. 이번 라운드가 푸는 문제

1. **연결이 실제로 깨진다.** ChatGPT Codex 백엔드(`chatgpt.com/backend-api/codex/responses`)가
   bare `gpt-5` 슬러그를 거부(400, *"not supported when using Codex with a ChatGPT account"*)하는데
   picker에서 고를 수 있었다.
   → **수정 완료 (landed):**
   - [shared/providers.ts](../shared/providers.ts) — `openai-codex` 모델 목록·catalog에서 `gpt-5` 제거(주석으로 *왜* 박음).
   - [src/features/providers/store.ts](../src/features/providers/store.ts) — `deriveSelection`의 raw‑key fallback이
     기존에 `gpt-5`를 고른 사용자의 localStorage 값을 되살려 계속 400을 내던 문제를,
     `openai-codex:gpt-5 → gpt-5-codex` 마이그레이션 한 줄로 차단.
   - ⚠️ 단, 이건 *한 건*의 증상이다. 4개 OAuth 프로바이더(특히 experimental인 OpenAI/Google)는
     여전히 **실계정 dogfood로 model id·백엔드 동작 검증** 필요(§A3).

2. **모델/프로바이더 선택이 빈약하다.** 현재 [`ProviderModelBar`](../src/features/agent/AgentChat.tsx)는
   "검색 가능한 combobox 드롭다운"이다 — 사용자가 말한 *"리스트 형식"*. 키보드 내비/최근·즐겨찾기/
   능력 배지/experimental 구분이 없다.

3. **탭 컨텍스트가 자동 주입 위주다.** 첫 턴에 워크스페이스/URL/캡처를 텍스트로 prepend
   ([loop.ts `buildUserText`](../electron/agent/loop.ts))하고, 런타임 도구(`get_console_errors`,
   `query_dom`, `read_network`…)는 일부만 on‑demand다. 목표는 **AI가 필요할 때만** DOM/네트워크/
   쿠키/스토리지/터미널/페이지를 가져오는 것(컨텍스트 절약) + `.claude`/`CLAUDE.md`/`AGENTS.md`/
   `.agents` 같은 지시 파일을 읽어 컨텍스트로 쓰는 것.

---

## 1. 리서치 요약 (근거)

### 1.1 Claude / Codex Desktop & best‑in‑class (모델 선택)
- **커맨드 팔레트 피커** — 검색 + 프로바이더 그룹 + 최근/즐겨찾기 + 능력 배지(vision·reasoning·tools)
  + 컨텍스트 윈도우 + **숫자키 1–9 선택**. (Claude `⌘⇧I`, Codex `/model`, T3 Chat 요청사항과 일치)
- 컴포저 통합 스위처(모델+추론강도+승인모드), experimental은 **"Show more"로 접기**(ChatGPT),
  selector에 **능력 부족 경고 배지**(Zed), **최근/즐겨찾기 persist**(T3), **세션 중 전환**(전부).
- 설정: 프로바이더를 **카드**로(OAuth "Connect" / API 키 / Advanced 접기) — Claude Connectors.

### 1.2 opencode (on‑demand 컨텍스트 & 도구)
- `Tool.define(name, { description, zod params, execute })` + **flat registry**.
- **프롬프트 stuffing 금지, on‑demand 페치** — 모델이 `read`/`grep`/`fetch`로 필요할 때만 가져옴.
- 지시 파일: `AGENTS.md > CLAUDE.md`(디렉터리별 **first‑match‑wins**) + 전역 fallback(`~/.config/<app>/AGENTS.md`,
  `~/.claude/CLAUDE.md`). 하위 디렉터리 규칙은 **그 영역을 건드릴 때만 `<system-reminder>` 블록으로
  지연 주입 + per‑message claim set**(중복 방지).
- MCP 도구 네임스페이싱 `<server>_<tool>`, **glob 권한 `allow`/`ask`/`deny`(last‑match‑wins)**,
  대용량 출력 truncation, 에이전트=YAML‑frontmatter 마크다운(filename=이름, body=system prompt).

---

## 2. 이번에 확정한 결정

| # | 질문 | 선택 |
|---|------|------|
| A | 모델/프로바이더 선택 UX | **커맨드 팔레트 피커** (centered, 키보드‑first) |
| B | 탭 컨텍스트 on‑demand 범위 | **in‑process 컨텍스트 툴부터** (외부 MCP 서버는 future) |
| 순서 | 무엇부터 구현 | **Track A(모델/프로바이더 UX) 먼저**, 그다음 Track B |

설계 문서를 먼저 쓰는 이유 = 프로젝트 메모리의 *design‑first* 원칙(목표 구조 + 마이그레이션 맵 먼저).

---

## 3. Track A — Provider/Model UX  *(build first)*

### A1. Command Palette Model Picker  ★ 핵심

**현재:** [`ProviderModelBar`](../src/features/agent/AgentChat.tsx) (AgentChat.tsx ~266–430) —
칩 버튼 → 칩 바로 아래 anchored 드롭다운(검색 input + 프로바이더 그룹 flat list). 키보드 내비 없음.

**목표 상호작용 스펙:**
- **트리거:** (a) 컴포저/바의 모델 *칩* 클릭, (b) 에이전트 surface 포커스 시 **키보드 단축키**
  (`Cmd/Ctrl+K` 후보 — 기존 단축키와 충돌 확인 필요; 충돌 시 `Cmd/Ctrl+Shift+M` 류).
- **레이아웃:** 화면 중앙 overlay(=command palette). 상단 검색 input, 본문 스크롤 그룹 리스트, 하단 힌트 바(↑↓ 이동 · ↵ 선택 · 1–9 빠른선택 · esc 닫기).
- **키보드:** `↑/↓` 하이라이트 이동(그룹 가로질러), `↵` 선택, `Esc` 닫기, **`1`–`9`** = 현재 보이는 N번째 항목 즉시 선택(Claude 트릭), 타이핑=필터.
- **그룹 순서:** ① **Recent**(최근 선택 N개, persist) → ② 키 있는 built‑in 프로바이더 → ③ 키 없는 built‑in → ④ custom 엔드포인트 → ⑤ **Experimental**(openai‑codex / google‑caa)는 항상 맨 아래 + `experimental` 배지.
- **행(row):** `[★즐겨찾기] 모델명  [능력 배지: vision/reasoning]  [context window]  [✓ 선택됨]`. 프로바이더 헤더에 키/연결 상태 닷.
- **즐겨찾기:** 행 hover 시 ★ 토글, persist. 즐겨찾기는 Recent 위 또는 별도 핀 그룹.
- **키 없음 경고:** 선택된 프로바이더에 키/연결이 없으면 인라인 배너 + Settings 링크(현재 동작 유지).

**데이터 모델 변경** ([shared/providers.ts](../shared/providers.ts)):
- `ModelEntry`에 선택 능력 필드 추가: `reasoning?: boolean; vision?: boolean`(배지용). `tools`는 이미 있음(에이전트는 tool‑capable만 노출).
- `ProviderDef`(PROVIDERS)에 `experimental?: boolean` 추가 → `openai-codex`, `google-caa`에 `true`.
- catalog well‑known 모델에 `reasoning`(o4‑mini, gpt‑5‑codex, grok‑code‑fast‑1 등)·`vision`(gpt‑5, gemini‑2.5‑*, claude‑*) 표기.

**store 변경** ([src/features/providers/store.ts](../src/features/providers/store.ts)):
- `recentModelKeys: string[]`(persist, key=`marudesk.providers.recentModelKeys`, 상한 ~6). `selectModel`이 unshift+dedupe.
- `favoriteModelKeys: string[]`(persist) + `toggleFavorite(key)`.

**컴포넌트:** 새 `src/features/agent/ModelPalette.tsx`(overlay + 키보드 로직). `ProviderModelBar`는 *칩(트리거)*만 남기고 드롭다운 본문을 ModelPalette로 이관. 팔레트는 재사용 가능하게(props: open/onClose).

**테스트:** e2e — 칩 클릭→팔레트 open, 검색 필터, 숫자키 선택, 선택 시 `{provider,model}` 반영, experimental 그룹 맨 아래.

### A2. Provider Settings 보강  *(작음 — 이미 카드형)*

[ProvidersSettings.tsx](../src/features/settings/ProvidersSettings.tsx)는 이미 아코디언 카드 + OAuth/Key/커스텀. 추가만:
- experimental 프로바이더 카드에 `experimental` 배지 + 한 줄 경고("undocumented backend; verify with your account").
- OAuth 카드에도 **"Test connection"**(현재는 key만) — 1‑토큰 헬스체크(예: 모델 1개로 `generateText` 짧게).
- 친절한 에러: OAuth/키 실패 메시지를 사람이 읽을 수 있게(§A3와 공유).

### A3. 연결 신뢰성  *(사용자 체감 "연결 안 됨" 직격)*

- **방어적 모델 검증** ([electron/agent/model.ts](../electron/agent/model.ts) `buildModel`): provider별 알려진
  static 카탈로그에 없는 modelId면, 보내기 전에 그 provider의 `defaultModelId`로 보정하거나 명확한 에러.
  (codex `gpt-5` 같은 *되살아난 dead 슬러그* 2차 방어선.)
- **친절한 에러 표면화** ([electron/agent/loop.ts](../electron/agent/loop.ts)): `APICallError`의 `responseBody.detail`을
  추출해 채팅에 사람이 읽을 메시지로(예: *"ChatGPT 계정은 gpt‑5‑codex만 지원합니다"*). raw 스택 대신.
- **(experimental) codex live model 발견**: 가능하면 `GET /backend-api/codex/models`로 실제 허용 모델 목록을
  받아 카탈로그를 대체/병합(설계 문서 §10이 권장). 실패 시 static fallback.
- **dogfood 체크리스트**(실계정): Anthropic / xAI / OpenAI(ChatGPT) / Google(Gemini) 각각
  connect→모델 선택→1턴 왕복→tool call→reasoning 스트림 확인. 결과를 oauth 문서 §10에 기록.

---

## 4. Track B — On‑demand Context Tools  *(next; in‑process)*

> 핵심 전환: "첫 턴에 컨텍스트를 밀어넣는다" → "**모델이 필요할 때 도구로 가져온다**".
> 사용자가 소스(요소/네트워크/쿠키/터미널…)를 *선택*하면 그건 시스템‑리마인더로 1회 첨부,
> 자연어로 요청하면 모델이 알아서 해당 도구를 호출.

### B1. 컨텍스트 도구 레지스트리 (네임스페이스 + on‑demand)
- 기존 [tools.ts](../electron/agent/tools.ts) TOOL_SCHEMAS/EXECUTORS를 opencode식으로 확장.
  네임스페이스 표기로 정리(이름 안정·glob 타깃 가능):
  - `browser_query_dom`, `browser_eval_js`(승인), `browser_page_text`(가시 텍스트/마크다운),
    `browser_cookies`, `browser_storage`(local/session — CDP `DOMStorage`/`Storage`),
    `devtools_console`(현 `get_console_errors` 확장: 에러뿐 아니라 로그 레벨 필터),
    `devtools_network` / `devtools_network_body`(현 `read_network*`),
    `terminal_output`(활성 터미널 스크롤백 — node‑pty/xterm 버퍼), `reload_and_verify`(유지).
- **CDP allowlist 재사용** ([electron/browser/cdp.ts](../electron/browser/cdp.ts)) — 쿠키/스토리지 *읽기*는
  `Network.getCookies`/`Storage.*`/`DOMStorage.*`가 이미 prefix 허용, 파괴적 twin은 차단. 읽기 도구만 추가.
- 도구 결과는 전부 `scrubText`(secrets 마스킹) 경유(현행 유지).

### B2. 지시 파일 로딩 (`.claude`/`CLAUDE.md`/`AGENTS.md`/`.agents`)
- **up‑front(작게):** 워크스페이스 루트에서 nearest‑first 위로 walk하며 `AGENTS.md` → 없으면 `CLAUDE.md`
  (first‑match‑wins) 수집 → system prompt에 합침. 전역 fallback은 데스크톱 앱 맥락상 옵션.
- **on‑demand(지연 주입):** 파일 도구가 하위 디렉터리를 열면 그 경로에서 위로 walk해 아직 안 본 지시 파일을
  찾아 **`<system-reminder>` 블록으로 도구 결과에 덧붙임 + per‑message claim set으로 중복 차단**(opencode `resolve`).
- `instructions` 설정 필드(글로브 + `{file:}`/`{env:}` 보간)는 future 옵션.

### B3. 컴포저 "+" 컨텍스트 메뉴 + `@` 멘션  *(v3 §5‑F 실현)*
- 입력창 "+" 팝오버 = Captures · 열린 탭/파일 · CDP 컨텍스트(요소/네트워크/쿠키/스토리지) · 터미널 · (future)MCP.
- `@` 멘션 picker(파일/디렉터리/탭). 선택 항목은 B1 도구를 *유도*하거나 시스템‑리마인더로 1회 첨부.

### B4. glob 권한 (allow/ask/deny)
- 민감 컨텍스트 도구 기본값: `browser_cookies`/`browser_storage`/`terminal_output` → **`ask`**,
  읽기 전용 DOM/console/network → `allow`, `browser_eval_js` → `ask`(현행 승인 유지).
- v3 Phase D(승인/자율 모드)와 합류: Read‑only / Auto / Full 모드가 이 기본값을 일괄 조정.

### B5. (future) 외부 MCP 클라이언트
- stdio/remote MCP 서버를 설정에서 추가, `<server>_<tool>` 머지, 대화별·툴별 on/off (Claude Connectors UX).
- 이번 라운드 범위 밖 — B1~B4의 in‑process 레지스트리를 "로컬 MCP provider"로 추상화해 두면 나중에 동일 머지 지점에 꽂힘.

---

## 5. 마이그레이션 맵 (파일별)

**추가**
- `src/features/agent/ModelPalette.tsx` — 커맨드 팔레트 overlay(A1).
- (B) `electron/agent/context-tools.ts` 또는 tools.ts 확장 — 네임스페이스 컨텍스트 도구(B1).
- (B) `electron/agent/instructions.ts` — 지시 파일 walk/resolve + claim set(B2).

**수정**
- `shared/providers.ts` — `ModelEntry.reasoning/vision`, `ProviderDef.experimental`, catalog 능력 표기. *(gpt‑5 제거는 done)*
- `src/features/providers/store.ts` — `recentModelKeys`/`favoriteModelKeys` + actions. *(마이그레이션 한 줄은 done)*
- `src/features/agent/AgentChat.tsx` — `ProviderModelBar`를 칩 트리거로 축소, 본문은 ModelPalette로.
- `src/features/settings/ProvidersSettings.tsx` — experimental 배지/경고, OAuth "Test connection"(A2).
- `electron/agent/model.ts` — `buildModel` 모델 검증(A3).
- `electron/agent/loop.ts` — APICallError 친절화(A3), (B) 지시 파일 주입·도구 등록.
- `electron/agent/tools.ts` / `electron/browser/cdp.ts` — (B) 읽기 컨텍스트 도구.

**제거**
- 없음(이번 라운드). gpt‑5 dead 슬러그는 이미 제거.

---

## 6. 단계 계획 + v3 매핑

| 단계 | 내용 | v3 매핑 | 비고 |
|------|------|---------|------|
| **A1** | 커맨드 팔레트 모델 피커 | F(provider/onboarding) | ✅ done — `ModelPalette.tsx` (typecheck+lint 0, build+e2e 50/50) |
| **A2** | 프로바이더 설정 보강(experimental/test) | F | 작음 |
| **A3** | 모델 검증 + 에러 친절화 + dogfood | — | 신뢰성 |
| **B1** | 컨텍스트 도구 레지스트리 | E/F | next |
| **B2** | 지시 파일 로딩 | F | next |
| **B3** | 컴포저 "+" / `@` | F | next |
| **B4** | glob 권한 ↔ 승인 모드 | D | Phase D와 합류 |
| **B5** | 외부 MCP 클라이언트 | F | future |

병행 가능: v3 Phase C(세션)·D(승인 모드)·E(증거 카드)·G(폴리시)는 독립. B4는 D와 자연스럽게 합류.

---

## 7. Non‑goals / 미해결
- 외부 MCP 서버 연결(B5)은 이번 범위 밖(in‑process부터).
- 멀티‑유저 OAuth, `marudesk://` 커스텀 프로토콜 — 기존 oauth 문서 non‑goals 유지.
- 컴포저 통합 스위처(모델+추론강도+승인모드)는 A1(팔레트) 안착 후 선택적으로 추가(연구상 강력하나 A 우선순위는 팔레트).
- codex/CAA model id의 **실계정 검증**은 코드가 아니라 dogfood로만 닫힌다(§A3).

---

## 8. 구현 현황 — claude-code / codex 흡수 라운드 (2026-06)

claude-code · codex의 채팅 UX를 벤치마크해 다음을 컴포저에 흡수(landed):

- **슬래시 커맨드**(`shared/slash-commands.ts` + 컴포저 `/` 메뉴): 로컬 액션
  (`/new` `/diff` `/context` `/help` `/model`)과 프롬프트 매크로(`/init` `/review`
  `/test` `/explain` `/commit`). 키보드 내비(↑/↓/Tab/Enter/Esc).
- **Plan 모드**(`AgentApprovalMode='plan'`): read-only처럼 편집/eval 차단 + 시스템
  애드덤으로 "단계별 계획 제시" 유도. 토글/Settings/StatusBar에 노출.
- **이미지 입력**(`AgentImagePart`/`AgentImageInput`): 붙여넣기·드롭 → 비전 모델로
  멀티모달 전달, 트랜스크립트 썸네일. `parse.ts`에서 IPC·릴레이 공통 검증.
- **생성 미디어 인라인**(`ToolMediaArtifact`): `generate_image`/`generate_video`가
  워크스페이스에 저장한 파일을 `ToolCall.media`(경로+타입만)로 실어 보내고, 렌더러는
  `workspace:read-media` 채널로 바이트를 지연 로드해 채팅에 이미지/`<video>`로 인라인
  표시(verbosity 무관). 영상 data: URL을 위해 `media-src` CSP 추가. 경로만 상태에
  담아 세션 히스토리는 가볍게 유지.
- **프롬프트 히스토리**(↑/↓ recall, localStorage, 100개 cap).
- **메시지 큐잉**: 턴 진행 중 Enter → 대기 후 자동 전송(취소 가능).
- **`@` 파일 멘션**: 캐럿 위치의 `@token`으로 워크스페이스 파일 picker(B3의 `@` 부분 실현).

미해결(실환경 검증 필요): 모바일 릴레이 라이브 와이어링(relay+phone E2E),
세션 teleport/핸드오프.

### 8.1 2차 라운드 (codex 코드 분석 후 흡수)

codex Rust 소스(`compact.rs`, `slash_command.rs`, 승인 UX)를 코드 레벨로 분석해 흡수:

- **`/compact`**(`loop.compactConversation`): codex 레시피 — 트랜스크립트를 대화 자체
  모델로 요약. 프로바이더 분기(anthropic-OAuth 프리픽스, codex `store:false`)는 기존 turn
  스캐폴딩 재사용. Anthropic 역할 교대를 위해 요약 뒤 합성 assistant ack를 둠.
  - **비파괴(claude-code/cursor 패리티)**: 화면 스크롤백(`state.messages`)은 보존하고
    모델 컨텍스트(`transcript`)만 치환. 압축 지점에 `AgentCompactionPart` 구분선(요약
    펼침 가능)을 추가. `/compact <focus>`로 특정 내용을 더 자세히 보존하도록 지시 가능.
  - **Tail preservation**: 오래된 head만 요약하고 최근 턴(문자 가중치 ~30%, 턴 경계로
    스냅)은 원문 유지 → 작업 중 맥락은 손실 0. `splitForTailPreservation`.
  - **자동 압축**(`agent.autoCompact`): 턴이 정상 완료될 때 컨텍스트가 모델 창의 임계치
    (기본 80%)를 넘으면 백그라운드로 압축. `usage.contextTokens`(최근 호출 입력 토큰 =
    실제 컨텍스트 점유)로 판단하며, 같은 값이 사용량 게이지도 구동.
- **"Allow always"** 승인(`sessionAllowedTools`): 게이트 툴을 이 대화 동안 항상 허용.
  reset/resume에서 클리어. 원격 always는 L-1 가드로 여전히 무효.
- **`/copy`**(대화 markdown 복사) + **`/status`**(`/context` 별칭 — provider·model·승인
  모드·토큰 표시).
- **Post-edit verify 훅**(`agent.verifyCommand`): 편집한 턴 종료 시 워크스페이스에서
  검증 명령 실행 → PASS/FAIL을 assistant 메시지에 환류. 증거 루프(편집→검증) 강화.

보류(컷라인 밖): 통합 커맨드 팔레트(Shell 전반 리팩터·클릭 검증 불가), execpolicy/OS
샌드박스(셸 실행 surface 생길 때), marudesk=MCP 서버, 서브에이전트, Fork/Side, 파일기반
커맨드(`.marudesk/commands`). 트리거가 생길 때 착수.
