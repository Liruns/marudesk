# marudesk — 제품 로드맵

> 상태: **살아있는 문서 · 방향 결정 + P0 설계 (구현 전)** · 작성 2026-05-31 · 범위: 제품 방향 + assist→agent 경로 + P0
> 동반 문서: [커스텀 DevTools 설계](./custom-devtools-design.md) (CDP DevTools 구현 설계)

이 문서는 "무엇을 만들지"보다 **"왜 이 순서로 만들지"**를 남기기 위한 것이다. 결정의 근거와 *기각한 것*을 함께 적는다.

## 1. 목표 & 나침반

- **지금:** 매일 쓸 만큼 좋은 도구(dogfooding이 설계 동력) + 강한 포트폴리오.
- **나중(옵션):** 시장에서 고려할 만한 매력적 선택지 / 매출.
- **나침반:** "내가 매일 켜는가?" + "모르는 사람이 한 번 써볼 legible한 이유 한 줄."
- **나침반이 *아닌* 것:** 방어 가능한 해자(moat). 이 단계에선 틀린 렌즈 — §4 참고.

## 2. 포지셔닝 / 차별화

**헤드라인은 추상이 아니라 구체적 루프로 말한다:**
> "브라우저에서 터진 에러/요청을 실제 런타임 데이터로 고치고, AI에게 무엇이 가는지 보고, 모든 패치를 네가 승인한다."

**왜:** 현재 AI 코딩 툴은 *소스만 보고 런타임을 추측*한다. marudesk는 WebContentsView + CDP로 실제 DOM/console/network를 소유 → AI가 추측이 아니라 데이터로 고친다.

**리드하지 말 것 (기각):**
- **"raw CDP / 자체 DevTools"** — 포트폴리오·README용이지 사용자 언어가 아님.
- **"비주얼 CSS 편집"** — Cursor Visual Editor / Lovable에 짐. [css-source.ts](../src/features/devtools/css-source.ts)는 same-origin 서빙 정적 CSS만 소스 매핑(Vite JS-injected `<style>`는 live-only) → 약속을 세게 걸면 위험.
- **"더 나은 AI 코딩"** — 코드젠 품질 · 병렬 클라우드 에이전트 · 생태계 · 인덱싱에서 짐. 경쟁하지 않는다.

**채택세(adoption tax) 해소:** marudesk는 디스크의 워크스페이스 파일에 패치한다 — 그 폴더는 사용자의 기존 IDE가 이미 watch 중. → "IDE 대체"가 아니라 **"네 폴더를 공유하는 런타임 디버깅 표면"**. Cursor를 켜둔 채 옆에서 쓸 수 있다. (그래서 §3의 agentic 야망과 "companion" 포지션은 메시징 수준에서 충돌 — agentic으로 가면 companion 프레임은 약해진다는 점을 기억.)

## 3. 전략 방향: assist-first → agent (결정 2026-05-31)

두 패러다임:
- **AI Chat (assist):** 사람이 증거를 모음 → 한 방 패치 → 검토 → 적용. (현재 capture→composer→patch 루프가 이것.)
- **Agentic IDE:** 에이전트가 도구로 관찰·수정·재확인을 자율 반복. (Codex Desktop / Claude Desktop 카테고리.)

**결정: assist 먼저 → agent.**
- P0를 사람-검토 단일 패치(assist)로 먼저 출시해 **runtime-tool 가치를 싸게 증명**한다.
- 같은 도구를 이후 Agent SDK 루프로 승격한다(§9).
- 종착지는 agentic IDE와 같되, 리스크를 최소화하고 데일리 훅을 먼저 확보.

**결정적 설계 규칙:** P0는 "assist 기능"이 아니라 **"에이전트 도구 + 사람 트리거"**로 짓는다. 추출 로직을 순수·도구 모양 모듈로 분리하고 UI는 그 위에 얹는다(§9). 이게 B→A 승격을 *재작업 없이* 가능하게 하는 조건.

**agentic에서 테제 업그레이드:** "런타임을 컨텍스트로 본다" → **"에이전트가 도는 앱을 몰고 *검증한다*."** 닫힌 루프(patch → reload → 재관찰 → "에러 사라졌나" 확인 → 반복)가 진짜 차별점.

**가지 않는 길 (기각):**
- *지금 바로 풀 agentic 빌드* — 에이전트 루프는 큰 아키텍처. 런타임 도구 가치를 증명하기 전에 짓는 건 과투자 + 코드젠 품질 경쟁의 늪.
- *Runtime MCP 제공자로만* — marudesk가 남의 에이전트의 한 기능이 되고 Chrome DevTools MCP와 정면 충돌 + 통합 IDE 포트폴리오 서사를 잃음.

## 4. 경쟁 맥락 (왜 "충분히" 방어되나)

- **Chrome DevTools MCP (Google, public preview)** + **Stagewise (YC)**가 "런타임을 보는 AI" 추상을 commoditize 중 — network/console/source-mapped stack을 외부 에이전트에 제공.
- **그러나 dogfood + 포트폴리오 목표에선 그들의 존재 = 문제 *검증*이지 실격 사유가 아니다** (해자가 목표가 아니므로). 포트폴리오 서사: "구글이 MCP로 낸 걸 통합 데스크톱 IDE로 독립 구현했다."
- marudesk의 위치: 외부 에이전트에 붙이는 부속이 아니라 **브라우저 + 에디터 + 터미널 + CDP를 한 로컬 루프로 소유.**
- 검증된 시장 갭(2026 초, 재확인 필요): DOM→source 매핑이 메이저 전반 미해결 · 모델에 가는 *정확한* 프롬프트를 노출하는 메이저 IDE 없음 · 전송 전 secret scrub 제품화 사례 드묾.

## 5. 로드맵 (단계)

| Phase | 한 줄 | 무엇을 푸는가 | 상태 |
|---|---|---|---|
| **P0** | Console 에러 → 증거팩 → patch → apply → reload 검증 | 매일 훅 + 루프 증명 | 설계 |
| **P0.5** | Network 응답 body → context, **scrub 필수** | 히어로 데모 + 신뢰 | 예정 |
| **P1** | Context Preflight + 신뢰도 붙은 소스 후보 | 채택 / 신뢰 | 예정 |
| **P1.5** | Evidence-pack export (Cursor / GitHub Issue) | 낮은 진입장벽 (companion) | 예정 |
| **P2** | 타입별 정답률 측정 + apply 강화 (멀티파일 / revert) | 매일 *믿고* 쓰기 | 예정 |
| **P3** | Ollama 로컬 모델 (저우선) | 옵션 | 예정 |

**v1 / 포트폴리오 공개 지점 = P0 + P0.5 + P1** (데일리 사용 + 히어로 데모 + 신뢰 장치).

- **P0.5 분리 근거:** 콘솔 에러는 원인이 대개 프론트 코드(패치 가능), 네트워크는 *status 실패*(401/500/CORS)는 원인이 백엔드/인프라일 때가 많음 → 네트워크는 "fix"가 아니라 **"원인 분류(triage)"** 프레이밍으로 시작. 단 *body 모양 이상*(예: `"10%"` 문자열 → NaN)은 프론트에서 결정론적으로 고쳐지고 **히어로 데모**가 여기 있음. 네트워크 body를 LLM에 보내려면 **secret scrub이 전제조건** → P0(콘솔)보다 무거워서 0.5.
- **운영 리듬:** 큰 폭포수 금지. P0를 *끝까지(reload 검증까지)* 닫고 → 며칠 dogfood → 막히는 지점이 다음 우선순위를 정함.

## 6. P0 — Runtime Error Fix Loop (grounded)

**이미 있는 것 (추가 구현 거의 불필요):**
- **콘솔 에러가 이미 구조화**: `Runtime.exceptionThrown` → `ConsoleEntry{kind:'exception', stackTrace:{callFrames}, url, lineNumber}` ([store.ts:1581](../src/features/devtools/store.ts#L1581)). 스택 프레임 `{functionName, url, lineNumber, columnNumber}` ([types.ts:148](../src/features/devtools/types.ts#L148)). `Runtime`/`Log`는 세션 시작부터 enable ([store.ts:521](../src/features/devtools/store.ts#L521)).
- **네트워크 준비됨**: `NetworkEntry`(status/failed/headers/initiator.stack) + `getResponseBody(requestId)` ([store.ts:1238](../src/features/devtools/store.ts#L1238)).
- **소비 지점 단일**: [buildUserMessage](../electron/llm.ts#L73) 한 곳에 분기 추가.
- **입력 UX 패턴 존재**: [captureSelected](../src/features/devtools/store.ts#L920) (Elements 선택 → `addCapture` → 카트)를 복제.
- **🔑 에이전트 도구 토대 이미 존재**: [sendCdp + isAllowedCdpMethod](../electron/browser/cdp.ts#L104) — main의 allowlist된 CDP 명령 레이어.

**최소 확장:**

| 레이어 | 변경 |
|---|---|
| [shared/capture.ts](../shared/capture.ts) | `kind` 판별자 추가: `'element'`(기존) \| `'console-error'`(신규). 기존 element 경로 불변. |
| 렌더러 [ConsolePanel](../src/features/devtools/panels/ConsolePanel.tsx) | 에러 row에 "Fix this" → `console-error` payload → 기존 카트 / composer |
| main [buildUserMessage](../electron/llm.ts#L73) | `kind`로 분기 → 에러 메시지 + 스택 + **스택이 지목한 파일**(결정론적, `rankFiles` 퍼지 랭킹 불필요) |
| verify | apply 후 reload(앱 네비게이션 경유 — `Page.navigate`는 allowlist 차단) + 같은 에러 시그니처 재감시 → 사라짐 / 잔존 보고 |

**P0가 충족하는 것:** 데일리 훅(콘솔 에러 복사 → stack 보고 파일 찾기 → 브라우저 상태 설명 → 관련 코드 전달 → 패치 → diff → 적용을 1분으로) + 루프 끝까지 증명(reload 검증) + 선명한 포트폴리오 데모.

## 7. 열린 결정 (구현 전 확정 필요)

**(A) 항상-켜짐 콘솔 캡처 vs dock-열림 전제 — "매일 쓰나"의 최대 레버.**
- *지금:* dock을 열어야 CDP가 붙어서, 보고 있던 에러만 잡힘 → "Fix this"가 거의 안 뜸 → 데일리 훅 실패.
- *데일리화:* 웹 탭마다 `Runtime`+`Log`만 수동적으로 항상 부착(패널 없이, 저비용) + 에러 배지 → dock을 한 번도 안 열어도 Fix this 가능.
- *제약:* single-client(사용자가 크롬 DevTools 열면 양보) · 약간의 attach 비용. 각 웹 탭은 다른 webContents라 멀티 탭 동시 부착은 OK.
- **확정(2026-05-31): "전 웹탭 항상-켜짐" 채택.** main 프로세스가 웹 탭마다 `Runtime`을 패시브 부착하고 **JS 에러만**(exception+console.error) per-tab 링버퍼(+배지)에 모은다 → dock을 한 번도 안 열어도 "Fix this" 가능. main-side 추출이라 §9 에이전트 도구 토대를 바로 쌓음. 구현 스펙 = §10. (기각: dock-열림 전제 = 데일리 훅 약함 / 활성-탭만 = 백그라운드 탭 에러 누락.)

**(B) 소스 라인 정밀도.**
- *파일 해소:* Vite dev의 same-origin 미러링([resolveStyleSheetSource](../src/features/devtools/css-source.ts) 패턴 재사용) → 결정론적.
- *정확한 라인:* JS source map 소비 필요 → **P0는 파일 + 런타임 라인**(LLM엔 충분), 정밀 라인은 나중.
- *정직한 약속:* DOM/스택→소스는 "정답 보장"이 아니라 "신뢰도 붙은 후보". 결정론적인 건 console-stack / network-initiator뿐.

## 8. Non-goals / FREEZE

- Sources 디버거 / 브레이크포인트, device emulation, profiler, storage/security/application 패널 확장, network waterfall 풀클론.
- **이유:** 사람용 파리티지 AI 컨텍스트를 *생산*하지 않는다. 필요하면 진짜 Chrome DevTools(`'chrome'` 탈출구)로 넘긴다.
- compliance / 규제 니치 포지셔닝 — 기각(catch-22: cloud egress를 금하는 조직은 솔로 개발 미검증 SW + 풀 CDP/fs/network 접근도 금함).

## 9. assist → agent 승격 (tool-boundary 규칙)

각 P0 조각이 미래의 에이전트 도구로 매핑된다 → assist는 버려지지 않는다:

| P0 (assist, 지금) | → agent (나중) |
|---|---|
| `RuntimeEvidence` shape (`shared/`) | 에이전트도 같은 증거 텍스트 생성 |
| 스택 → 소스 해소 (main) | 에이전트 도구가 그대로 호출 |
| `sendCdp` + allowlist (main, **이미 존재**) | 에이전트의 런타임 도구 (`eval_js` / `get_response_body` / `inspect_dom`) |
| "사람이 Fix this 클릭 + 카트 / composer" UI | **유일한 assist 전용** → 드라이버만 사람 → Agent SDK 루프로 교체 |

**에이전트 두뇌는 자체 제작하지 않는다** (코드젠 품질 경쟁 = 늪). **Claude Agent SDK**를 쓰고, 그들이 못 닿는 런타임 도구 + 통합 루프로만 차별화한다.

## 10. P0 구현 스펙 (2026-05-31 확정 — 결정 A = 전 웹탭 항상-켜짐)

> 짧게 끊은 시공 스펙. 라인은 shift 가능 — 구현 시 직접 확인. console-first: 네트워크 body(P0.5)·secret scrub은 범위 밖.

### 데이터 흐름
- **always-on (main)**: 웹 탭 생성/네비 시 CDP attach + `Runtime` enable(패시브, 패널 UI 없음; `Log`/`Network`/`DOM`은 미-enable — dock 열 때만) → `dbg.on('message')`에서 **JS 에러만** 추출해 per-tab 링버퍼(cap 50) + `devtools:error-count` 배지.
- **fix loop**: ConsolePanel 에러 row "Fix this" → `console-error` Capture → 기존 `addCapture`→composer `propose`→`llm:propose-patch`→`setOps`→patch preview/apply (변경 없음).
- **seed**: dock 열 때(`_openFor` 성공) `devtools:pull-errors`로 main 버퍼를 console 슬라이스에 `exception` 엔트리로 주입 → dock-전 에러도 row로 보이고 "Fix this" 가능.
- **verify**: apply 후 `browser:reload`(이미 존재; `Page.navigate`는 allowlist 차단이라 앱 reload 경유) → 같은 에러 시그니처 재감시(버퍼/배지) → 사라짐/잔존.

### 신규 순수 모듈 (assist→agent 승계, §9)
- **`shared/runtime-evidence.ts`** (pure, import 0): `ConsoleErrorEvidence{ message; stack: StackFrameLite[]; source?: {url; lineNumber?}; timestamp }` + `extractConsoleError(method, params): ConsoleErrorEvidence | null` (`Runtime.exceptionThrown` + `consoleAPICalled(type:'error'|'assert')` 정규화 — **JS 에러만**; `Log.entryAdded`(네트워크/리소스/CSP)는 P0.5 triage로 미룸) + `urlToWorkspacePath(url, origin): string | null` ([css-source.ts](../src/features/devtools/css-source.ts) `resolveStyleSheetSource` same-origin 패턴의 메인용 쌍둥이). → 미래 에이전트 `get_console_errors` 도구가 같은 추출 재사용.

### IPC / 스키마 (shared/ipc.ts)
- invoke `devtools:pull-errors`: `{ args: [{ tabId: string }]; result: ConsoleErrorEvidence[] }`.
- event `devtools:error-count`: `{ tabId: string; count: number }`.
- `Capture`([shared/capture.ts]) → **판별 유니온**: `{kind:'element', …기존 필드} | {kind:'console-error', message, stack?, source?}`. 공통 `id/timestamp/url`. **기존 element 런타임·랭킹 경로 불변**(narrow만 추가). `CapturePayload`([shared/composer.ts]) 동일 유니온화.

### 파일별 변경
| 파일 | 변경 |
|---|---|
| `shared/runtime-evidence.ts` | **NEW** pure: evidence 타입 + `extractConsoleError` + `urlToWorkspacePath` |
| `shared/capture.ts` | `Capture` 유니온화(`kind`) |
| `shared/composer.ts` | `CapturePayload` 유니온화 |
| `shared/ipc.ts` | `devtools:pull-errors`(invoke) + `devtools:error-count`(event) — `IpcMapIsComplete`/`EVENT_CHANNELS` 갱신 |
| `electron/browser/state.ts` | per-tab `errorBuffer` Map + `pushError`/`getErrors`/`clearErrors`/`errorCount` 접근자(leaf) |
| `electron/browser/cdp.ts` | `message` 리스너에서 `extractConsoleError`→`pushError`+`devtools:error-count`(host로 coalesce); `enableConsoleCapture(rec)`=attach+`Runtime` enable |
| `electron/browser/tabs.ts` | `createTab('web')`에서 `enableConsoleCapture`; `did-navigate`(메인프레임)→`clearErrors`+재-enable; `did-start-loading`(크래시 복귀)→재attach |
| `electron/browser/handlers.ts` | `defineHandler('devtools:pull-errors')` — `tabId` web 탭 검증 |
| `electron/inspect-overlay.ts` | `browser:capture` 페이로드에 `kind:'element'` |
| `electron/llm.ts` | `isCapturePayload` 유니온 검증; `buildUserMessage` kind 분기 → console-error: 메시지+스택+`urlToWorkspacePath`로 해소된 파일(결정론적, `rankFiles` 미사용) |
| `src/features/devtools/store.ts` | `_openFor`(및 `rebindToActive`) 성공 후 `pull-errors`→console seed |
| `src/features/devtools/useDevtoolsEvents.ts` | `devtools:error-count` 구독 → `errorCountByTab` |
| `src/features/devtools/panels/ConsolePanel.tsx` | error/exception row "Fix this" → console-error Capture → `addCapture`+토스트 |
| `src/features/composer/store.ts` | `toPayload` kind 분기 |
| `src/features/context/CaptureCard.tsx` | `kind` 분기 렌더(console-error 카드: 메시지+source, rank 미호출) |
| `src/features/workspace/store.ts` | `rankCapture`를 element로 narrow |
| 배지 UI | DevTools 토글 버튼(BrowserCanvas) — 활성 탭 `errorCountByTab` |

### 항상-켜짐 생명주기 / 함정
- **단일 CDP 클라이언트**: 크롬 DevTools(`'chrome'` 탈출구) 열면 `'detach'`→배지 정지. 닫은 뒤 자동 재attach 없음 → **다음 네비에서 재attach**(P0 수용, 문서화).
- **패시브는 `Runtime`만**(저볼륨 — `consoleAPICalled`/`exceptionThrown`). `Log`(네트워크/리소스 노이즈)·`Network`·`DOM`은 미-enable(플러드 방지; dock 열 때만). 각 웹 탭은 다른 webContents라 멀티 탭 동시 부착 OK. 배지 이벤트는 popup이 아니라 항상 host로(툴바 전용).
- 버퍼는 **메인프레임 네비에서 clear**(새 문서엔 stale). `preserveLog`는 dock 전용(버퍼엔 미적용).
- **소스 라인**: stack의 frame.url→파일은 결정론적이나 라인은 *서빙/트랜스파일* 라인(소스맵 미소비, 결정 B). LLM엔 "파일 + 런타임 라인(트랜스파일 후 다를 수 있음)"으로 정직하게 전달.

### 증분 순서 (각 단계 후 typecheck)
1. `shared/runtime-evidence.ts` + `shared/capture.ts`/`composer.ts` 유니온 + 기존 element 경로 narrow(컴파일 그린 회복).
2. main always-on: state 버퍼 + cdp `enableConsoleCapture`/추출 + tabs 배선 + `pull-errors`/`error-count` IPC+핸들러.
3. 렌더러: error-count 배지 + dock seed.
4. "Fix this" → console-error Capture → `toPayload`/`CaptureCard` 분기.
5. `electron/llm.ts` kind 분기(결정론적 파일 해소).
6. verify: `browser:reload` 후 재감시(수동 GUI 스모크 + 기존 e2e 그린).

---

### 부록 — 결정 로그

- **2026-05-30:** 5-에이전트 경쟁 정찰 + bear/bull 스트레스 테스트.
- **2026-05-31:** 전제 재토론 → 목표 = dogfood + 포트폴리오(매출 옵션). 차별화 = 런타임 컨텍스트. compliance 니치 기각.
- **2026-05-31:** 2차 AI 비평 반영 → console/network 분리, scrub을 P0.5 전제로, companion 프레이밍, "raw CDP 리드 금지".
- **2026-05-31:** 방향 = **assist-first → agent** 결정. P0 = "에이전트 도구 + 사람 트리거"로 설계.
- **2026-05-31:** P0 설계를 코드로 검증(루프 전구간) + **결정 A = 전 웹탭 항상-켜짐 콘솔 캡처** 확정. P0 구현 스펙 §10 작성, 증분 구현 착수.
