# marudesk — Agentic AI Chat **v3** UI/UX 재설계 (Antigravity · Claude Desktop · Codex Desktop 패리티)

> 상태: **설계 확정 (2026-06-01) · Phase A 완료 + Phase B 구현** · 범위: 신규 기능(OAuth 로그인·tool별 카드·커스텀 엔드포인트) 안착을 위한 **화면/디자인/레이아웃 재배치** + AI Chat을 **Antigravity / Claude Desktop / Codex Desktop** 급 표면으로
> 동반: [v2 설계](./agentic-chat-v2-design.md)(AI SDK + model-first, Phase 1–4 대부분 구현) · [v1 설계](./agentic-chat-design.md) · [로드맵](./roadmap.md) · [OAuth](./oauth-providers-design.md)
> 전제: v2의 **FREEZE / positioning 가드레일 계승** — 차별점은 **런타임 CDP 도구**(도는 앱을 보고 검증), 단일 활성 대화, 일반 코딩 에이전트 클론이 되지 않음.

---

## 0. 한 줄

v2는 **모델 레이어(AI SDK)·model-first 설정·tool별 카드**까지 끌어올렸다. v3는 그 위에서 **제품 표면(레이아웃·정보구조·디자인)**을 Antigravity/Claude/Codex Desktop 급으로 재배치한다: ① AI Chat을 **380px 우측 드로어에 가두지 않고 1급 표면(탭 kind)**으로 승격(드로어는 "브라우저 옆 companion" 모드로 보존), ② **세션 히스토리**(D2)·**reasoning 블록**(Phase 4 잔여)·**승인 모드**(Codex)·**plan/todo 표면**을 더해 매일 켜는 제품으로, ③ **신규 기능(OAuth·커스텀 엔드포인트)을 설정/온보딩에 제대로 안착.** 차별점(CDP)은 더 도드라지게 보존.

---

## 1. 현재 상태 (코드 기준 teardown, 2026-06-01)

### 1.1 AI Chat이 사는 곳 — **380px 우측 드로어**
- [Shell.tsx](../src/views/Shell.tsx) → [ContextDrawer.tsx](../src/features/context/ContextDrawer.tsx): `width: open ? 380 : 0`인 `<aside>`. 내부에 **Agent / Captures** 2탭. Agent 탭이 [AgentChat.tsx](../src/features/agent/AgentChat.tsx)를 렌더.
- 토글: [ActivityBar.tsx](../src/components/ActivityBar.tsx)의 `MessageSquareText` 버튼(`drawerOpen`).
- **함의:** 폭 380px 고정 → Claude Desktop의 중앙 정렬 넓은 대화나 Antigravity의 mission-control, Codex의 task 뷰 같은 "풀 표면" 경험이 구조적으로 불가능. 가장 협소한 선택.

### 1.2 채팅 컴포넌트 구조 ([AgentChat.tsx](../src/features/agent/AgentChat.tsx))
- `ProviderModelBar` — 상단. **model-first 검색 콤보박스**(provider 그룹 헤더, context window, 키 유무 점). v2 §6.1 완료. ✅ 이미 Claude/Codex급.
- 스크롤 transcript:
  - `EmptyState` — 중앙 정렬, Sparkles, 제안 3개.
  - `MessageView` — user=우측 정렬 accent-subtle 버블 / assistant=flat 텍스트 + parts(텍스트/tool) 인라인.
  - `StreamCaret` — 깜빡이는 accent caret(스트리밍 라이브 엣지). ✅
  - `ToolCardView` — **tool별 전용 카드**(접이식). runtime/CDP 도구는 `border-l-accent` 스파인 + accent 아이콘. `reload_and_verify` verdict 칩 / `get_console_errors` confidence 칩 / `eval_js` 표현식. v2 Phase 4 완료. ✅ 차별점 노출 OK.
  - `ChangesSection` / `EditCard` — 적용된 edit에 **Keep / Revert**(per-edit). `DiffBlock` 인라인. ✅
  - `ApprovalCard` — warning 톤 Approve/Deny.
  - `QuestionsCard` — accent 톤, 옵션 칩 + 자유 입력.
- footer: `StatusPill`(7-state) + `UsageMeter`(input/contextWindow 링) + New chat + textarea(2행) + Send/Stop.

### 1.3 상태 모델 ([shared/agent.ts](../shared/agent.ts) · [loop.ts](../electron/agent/loop.ts))
- `AgentChatState`: `turnId, status(7-state), messages(parts: text|tool), edits, pendingApproval, pendingQuestions, usage{input,output}, error`.
- main 소유 단일 `state` + `transcript`(ModelMessage[]); 렌더러는 `agent:event` 스냅샷 투영(스트리밍은 틱마다 텍스트 누적으로 표현).
- **없는 것(갭):** ① **세션/대화 히스토리** — `reset()`이 전부 날림(단일 대화). ② **reasoning/thinking 파트** — [loop.ts:245](../electron/agent/loop.ts#L245) `fullStream`에서 `text-delta`만 소비, `reasoning-delta` 버림. ③ **plan/todo** 개념. ④ **승인 모드**(Suggest/Auto/Full-Auto) — `GATED_TOOLS`는 항상 승인 요청. ⑤ 타임스탬프/토큰 외 **턴 메타**.

### 1.4 설정 / provider ([SettingsView.tsx](../src/features/settings/SettingsView.tsx) · [ProvidersSettings.tsx](../src/features/settings/ProvidersSettings.tsx))
- Settings = `settings` 탭 kind. VSCode식 좌측 카테고리 레일(Appearance/Editor/Terminal/Browser/**AI Providers**/Browser DevTools/About).
- **AI Providers**: provider 카드 아코디언. 각 카드에 **OAuth 로그인**(`OAuthConnect`: manual-paste=Anthropic / loopback=xAI / experimental=openai-codex·google-caa) + **API 키 에디터**(reveal·test·remove). 하단 **Custom endpoints**(OpenAI-compatible add/remove/key). 모델 선택은 채팅에서. ✅ 기능은 다 있음 — 단 **온보딩/발견성 약함**(activity bar 기어 메뉴 깊이, 빈 상태에서 "키 없음" → Settings 딥링크뿐).

### 1.5 셸 chrome
- [TitleBar](../src/components/TitleBar.tsx)(드래그 + Chrome식 탭 + 윈도우 컨트롤) · [ActivityBar](../src/components/ActivityBar.tsx)(48px 좌측 레일: Explorer/Context/Settings) · [StatusBar](../src/components/StatusBar.tsx) · [Stage](../src/features/tabs/Stage.tsx)(탭 본문, grid/split).
- 탭 kind 레지스트리([registry.tsx](../src/features/tabs/registry.tsx)): `web / home / terminal / editor / settings`. **`agent`/`chat` kind 없음** ← v3 승격의 1줄 삽입 지점.

## 2. 디자인 시스템 인벤토리 (재사용 어휘, [tokens.css](../src/styles/tokens.css) · [tailwind.config.ts](../tailwind.config.ts))

> **하드코딩 hex 금지 — 토큰만.** Linear 기반 dark-first, 단일 violet accent.

| 그룹 | 토큰 | 비고 |
|---|---|---|
| Surface | `surface-page #08090A` · `surface-1 #1A1B1F` · `surface-2 #23252B` · `surface-3 #2D2F36` | 페이지→패널→카드→입력/hover |
| Text | `fg-primary/secondary/tertiary/disabled` | |
| Border | `border-subtle/default/strong` | 알파 화이트 |
| Accent | `accent #5E6AD2` · `accent-hover` · `accent-subtle` | 단일 violet |
| Semantic | `success #4CB782` · `warning #F2C94C` · `error #EB5757` (+`-subtle`) | |
| **AI timeline** | `ai-thinking`(peach) · `ai-grep`(sage) · `ai-read`(blue) · `ai-edit`(lavender) | **Cursor 4색 — 토큰엔 있으나 거의 미사용.** v3 tool/타임라인 시각화의 잠재 자산 |
| Diff | `diff-add/remove` | |
| Type | `caption .75 · body-sm .8125 · body .875 · title 1.125 · section 1.5 · hero 2.5`(rem) | rem → Interface zoom 연동 |
| Font | `display`(Inter Display) · `body`(Inter) · `mono`(JetBrains Mono) | |
| Radius | `sm 4 · DEFAULT 6 · lg 10 · pill` | |
| Shadow | `glow` · `lifted` | 팝오버/모달 |
| Motion | `fast 120ms · standard 200ms` · `cubic-bezier(.2,0,0,1)` | |
| Light | `:root[data-theme=light]` — surface/text/border만 flip, accent·semantic 유지 | |

**UI 프리미티브:** `Button`(primary/secondary/ghost × sm/md/lg) · `Badge`(neutral/accent/success/warning/error) · `DiffBlock` · `Surface` · `Drawer` · `Spinner` · `Toast`.

## 3. 신규 기능 → 안착해야 할 표면 (이번 작업의 동기)

최근 추가됐으나 **화면 배치가 못 따라간** 기능:
1. **OAuth 구독 로그인**(Claude/Grok/ChatGPT/Google) — 설정 깊숙이. 온보딩·발견성·"연결됨" 상태 노출 약함.
2. **tool별 typed 카드 + CDP 증거 칩 + 스트리밍 caret** — 380px 드로어라 카드가 눌림.
3. **커스텀 OpenAI-compat 엔드포인트** — 설정에만. 채팅 셀렉터엔 그룹으로 뜨나 추가 동선 약함.

→ "신규 기능이 여럿 추가됨 → 화면/디자인/레이아웃 수정 필요"의 정체. v3는 이 셋을 **풀 표면 + 온보딩 + 모델/계정 패널**로 안착시킨다.

## 4. 3-제품 리서치 — *(병렬 에이전트 진행 중, 2026-06-01)*

> Antigravity(Google) · Claude Desktop(Anthropic) · Codex(OpenAI, CLI/IDE/cloud) 의 레이아웃·정보구조·기능·메뉴·설정을 GitHub 소스 + 웹검색으로 분석 중. 완료 시 아래에 제품별 요약 + "차용/기각" + "차용 가능한 구체 패턴 Top N" 채움.

### 4.1 Antigravity (Google) ✅
> 출처: developers.googleblog, Wikipedia, Google Codelabs/Medium, Apidog/index.dev 리뷰, **누출 시스템 프롬프트(x1xhlol/system-prompts repo)**, antigravity-sdk-python, 2.0 TechCrunch/TNW (전체 URL은 부록). VS Code 포크(Windsurf 계보).

**레이아웃 — Editor ↔ Agent Manager 풀 모드 전환(`Cmd+E`)**
- **Editor View**: 표준 VS Code 3-pane + 우측 **Agent Side Panel**(`Cmd+L`).
- **Agent Manager View**(★ mission control): 3-컬럼 = **Workspaces/Playground/Browser** | **Inbox**(모든 대화 스레드, 스레드별 **Idle/Running/Blocked** 배지 — "코드용 이메일 받은편지함") | **Work area**(프롬프트 + artifact review + 모델 셀렉터 + Fast/Planning 모드 + Review Changes diff). 파일 트리는 기본 숨김 — **대화·artifact가 1급**.

**artifacts = 핵심 출력 primitive (★ raw tool-call JSON 대체)**
- **Task List**(`task.md`): 동적 체크리스트 `[ ]`/`[/]`/`[x]` — 의존성 발견하며 add/remove.
- **Implementation Plan**(`implementation_plan.md`): Goal/Context·Breaking changes·Proposed changes(컴포넌트별)·Verification steps. **BLOCKING(실행 전 승인 필수)** + **Google-Docs식 인라인 코멘트**(하이라이트→코멘트→에이전트가 재시작 없이 반영). ← Antigravity 고유.
- **Walkthrough**(`walkthrough.md`): 검증 후 생성 — Features + **Verification evidence(UI 스크린샷·에이전트 브라우저 조작 녹화·터미널 로그)** + 수정 파일 링크. "auditable evidence".

**에이전트 task UX**
- `task_boundary` 호출 시 UI가 **Task Card**(TaskName/TaskSummary/TaskStatus)로 전환; task 모드 중엔 `notify_user`로만 소통.
- 모드: **PLANNING**(plan.md 작성) → **EXECUTION** → **VERIFICATION**(walkthrough 작성). **Fast vs Planning** 토글은 입력창 위.
- **자율성 4 프리셋**(초기 화면/Settings): Agent-Driven / **Agent-Assisted(기본)** / Review-Driven / Custom. **2축** = Terminal Execution(Off/Auto/Turbo) × Artifact Review(Always Proceed/Agent Decides/Request Review). ← Codex 승인모드와 같은 발상.
- **Blocked 게이트**: 미허용 명령/artifact 승인/워크스페이스 밖 접근/민감 브라우저 액션 시 스레드 freeze + Blocked 배지 + 우측 모달 "Review/Approve".

**multi-agent / async (대부분 우리 FREEZE)**: Inbox 병렬 5–8 스레드, **per-agent 모델 지정**, Scheduled Tasks(cron), Dynamic Subagents(frontend/backend/test 분기). Standalone Conversations(워크스페이스 없이).

**composer / 컨트롤**: 입력창 "Ask anything" + `@`(파일/디렉/MCP/`@workspace`/`@codebase`/`@terminal`/`@problems`/`@selection`) + `/`(저장된 Workflow) + `+`(이미지/파일). 각 응답 아래 **Proceed / Undo changes up to here**. **Problems 패널 "Send all to Agent"**(전체 에러 1클릭).

**★ marudesk 차별점과 직접 겹치는 부분 (브라우저 서브에이전트)**
- 전용 Chromium을 에이전트가 조작(navigate/click/fill/screenshot/**record**/read DOM·console/eval JS) → **녹화·스크린샷이 Walkthrough에 검증 증거로 박힘**. **타깃 DOM에 파란 테두리 "에이전트 커서" 오버레이.** 신규 파일 = 파일트리 **녹색** 표시.
- **이게 정확히 marudesk의 포지셔닝**("에이전트가 도는 앱을 보고 *검증*", CDP `reload_and_verify`). **시장 리더가 우리 wedge를 검증** — marudesk는 CDP로 같은 걸 하되 *통합 로컬 루프*로. → 차용: **에이전트 브라우저 오버레이(CDP highlight), 검증-증거 artifact 카드(reload_and_verify를 walkthrough급 카드로), "Fix all console errors".**

**설정**: VS Code Settings 위에 Antigravity 섹션 — Models / **Agent Permissions**(카테고리별) / Terminal(Policy+Allow/Deny+Sandbox) / Artifact Review / File Access / Browser URL Allowlist / Auto 동작. Rules(`~/.gemini/GEMINI.md`+`.agent/rules/`)·Workflows(`.agent/workflows/`)·Skills. MCP Store(카드+toggle).

**디자인**: VS Code 다크 포크(Default Dark/Tokyo Night), 상태 색배지, **파란 에이전트 커서**, Thought 접이식 섹션, 고밀도. Open VSX 테마 호환.

**marudesk 차용 후보 (Top)**: ① **에이전트 브라우저 오버레이(파란 테두리)** — CDP로 우리만 자연스럽게 가능 · ② **검증 증거 artifact**(reload_and_verify → 스크린샷/콘솔 before·after 카드) · ③ **Task List/Plan artifact**(§5-E; plan은 비-강제 — v2 결정) · ④ **Fast/Planning(또는 승인) 모드 토글 입력창 근처** · ⑤ **"Send all to Agent"**(Console 패널 "Fix all") · ⑥ `@` mention(파일/CDP 컨텍스트/MCP) · ⑦ Inbox = **세션 목록**(단, **병렬 실행은 기각** — 단일 대화) · ⑧ 응답별 Proceed/Undo.
**기각**: **multi-agent 병렬 실행 / Scheduled Tasks / Dynamic Subagents / per-agent 모델**(FREEZE — 단일 대화) · plan 강제 BLOCKING(우린 옵션) · VS Code Settings 오버레이(우린 GUI store).

### 4.2 Claude Desktop ✅
> 출처: code.claude.ai/docs, support.claude.com, Anthropic 블로그, assistant-ui Claude clone(reverse-eng), Commercial Type/Klim 폰트, MCP Apps 가이드라인 (전체 URL은 부록).

**레이아웃 / 정보구조**
- **3개 최상위 탭**: Chat / Cowork / Code (윈도우 chrome). → marudesk의 **탭 kind**와 정확히 같은 발상.
- **좌측 사이드바**(고정 ~240–280px): 하단 좌측 **아바타**(→ Settings/Billing/Logout 드롭다운) · 상단 **New Chat**(⌘N) · **Starred** · **Recents**("View all") · **Projects**(폴더, 펼치면 대화 목록) · 토글(⌘.).
- **중앙 정렬 대화 컬럼**(폭 제한 — 너무 좁다고 폭 확장 확장프로그램이 존재할 정도). assistant 텍스트는 prose 컬럼, 풀폭 아님.
- **Artifacts = 우측 분할 패널**(대화는 좌측 유지, 계속 입력 가능).

**대화 렌더링 (signature)**
- **비대칭 메시지**: user = **우측 정렬 버블**(`rounded-2xl`, `max-w-80%`, 약간 어두운 surface) / assistant = **버블 없음, 배경 위 풀폭 prose**, 좌측 정렬. **아바타 없음.** 타임스탬프 기본 숨김.
- **hover-reveal 액션바**(`opacity-0 group-hover:opacity-100`): copy/regenerate/👍👎 — 읽는 동안 깨끗.
- 코드블록: 언어 라벨(좌상) + hover copy.
- **스트리밍 = 깜빡 caret**(별도 typing indicator 없음). 5초 후 **경과 타이머** 표시(thinking/tool 공통).

**tool / MCP UX**
- **collapsible tool-call 행**: spinner→✅check→error 카드. **연속 동종 호출 병합**("40 file reads" → 1행 "40 actions" + 요약). chevron 펼침. **Verbose/Normal/Summary** 보기 모드.
- **승인 카드 인라인**(세션 스코프; 터미널/fs 등 광범위 권한엔 경고 콜아웃). "Allow for this session" / "Deny".
- 인터랙티브 커넥터 = 샌드박스 iframe 인라인 카드(≤500px) + **풀스크린 확장 시에도 composer 유지**.

**composer / 모델 / 컨트롤**
- **composer 좌하단 "+" 팝오버** 하나에 Connectors·Web search·Extended thinking·Attach 모음 → 바가 깔끔(아이콘 줄 없음).
- **모델 피커 = 대화 상단 드롭다운**(대화 중 변경 불가, 새 챗 필요).
- **"/" 슬래시 메뉴**(저장된 프롬프트/명령 자동완성). **Extended thinking 토글**(켜면 접이식 "Thinking" 블록 + 라이브 타이머).
- 단축키: New Chat ⌘K · Focus input Shift+Esc · Toggle sidebar ⌘. · Submit Enter · Stop Esc · Toggle Artifacts ⌘⇧P · Copy response ⌘⇧C.

**설정 카테고리**: General / Account / Privacy / Billing / **Capabilities**(Artifacts 등 토글) / **Connectors**(MCP 관리) / Claude Code / **Appearance**(Light·System·Dark + 폰트 Default·System·Dyslexic).

**디자인 언어 (the "Claude feel")**
- **따뜻한 off-white**: 페이지 `#F0ECE0`/dark `#2b2a27`, surface `#fff`/`#1f1e1b`, border/bubble `#E5E0D6`. **순백/순흑 없음** — 모든 중립이 warm.
- **단일 coral/rust accent `#c96442`**(라이트/다크 동일).
- **타이포 = 기능엔 sans(Styrene), 대화엔 serif(Tiempos)** — 대부분의 테크 앱과 반대. 가중치 **400/600 두 개만**. 본문 line-height 1.4.
- **flat surface에 그림자 없음** — border-only 정의(0.5px). 둥근 모서리 일관(`rounded-2xl`). composer만 gradient fog.
- 철학: AI를 "기술적/위협적"으로 보이지 않게 — calm·warm·minimal·typography-forward.

**marudesk 차용 후보 (Top)**: ① 비대칭 메시지(이미 부분 적용 — user 버블/assistant flat; **아바타 제거·prose 폭 제한** 강화) · ② **연속 동종 tool 호출 병합 + 경과 타이머** · ③ **Thinking 접이식 블록**(§5-C와 직결) · ④ **composer "+" 팝오버**(captures·tools·attach 통합) · ⑤ sticky composer + gradient fog · ⑥ hover-reveal 메시지 액션바 · ⑦ 사이드바 Starred/Recents/Projects(§5-B 세션) · ⑧ 보기 모드(Verbose/Normal/Summary).
**기각**: warm-beige 팔레트 전면 교체(우린 Linear violet 브랜드 유지 — accent만 신중히) · Projects/Knowledge(워크스페이스가 이미 그 역할) · Cowork.

### 4.3 Codex (CLI/TUI · IDE · App · Web) ✅
> 출처: developers.openai.com/codex, **openai/codex 오픈소스**(codex-rs/tui: app.rs·chatwidget.rs·bottom_pane/), PR #19709/#2185/#12581/#11447, DeepWiki, config-reference (전체 URL은 부록).

**form factor별 레이아웃**
- **TUI**(오픈소스): `ChatWidget`(transcript, `HistoryCell` 스택) → `StatusIndicatorWidget`(ephemeral 진행) → `BottomPane`(`ChatComposer` + **overlay stack**) → `StatusLine`(설정형 footer). overlay가 composer보다 이벤트 우선 소비.
- **IDE 확장**: 우측 사이드바. thread → composer → **컨트롤 행(composer 아래)**: `[Chat | Agent | Agent (Full Access)]` 승인모드 + 모델 피커 + reasoning effort + "Run in cloud".
- **Desktop App**(Electron): **3-pane** = Project/Thread 사이드바 | 액티브 thread(+live Task Sidebar: Plan/Sources/Artifacts/Summary) | **Review Pane**(인라인 diff/스테이징/PR 코멘트, ⌘⌥B). 통합 터미널(⌘J)·인앱 브라우저.
- **Web**: task 목록 + "Code/Ask" 2버튼 + task 상세(실시간 로그/plan/diff).

**agent task UX (signature)**
- agent 활동 = 타입된 `HistoryCell`: `command_execution` / `file_change` / `mcp_tool_call` / `web_search` / `reasoning` / `plan_update` / `agent_message`. (marudesk의 tool 파트와 동형 — **plan_update**가 우리에게 없는 것.)
- **diff = 4-레이어**(gutter·sign `+/-`·syntax content·**풀폭 배경 tint**), 테마 인식(dark add `#212922`/del `#3C170F`).
- **patch preview 셀을 승인 모달 *앞에* transcript에 push** → 모달은 **결정+메타만**(diff 본문은 위 히스토리). ← marudesk `ApprovalCard` 개선 포인트.
- **자동 리뷰어 서브에이전트**: 승인 요청을 사용자에 올리기 전 데이터 유출/크리덴셜/파괴적 행위 평가(Reviewing/Approved/Denied). 우리 CDP `eval_js` 승인에 응용 여지.

**승인 모드 (★ 우리 §5-D 직접 검증)**
- 2축: `approval_policy`(untrusted/on-request/never/granular) × `sandbox_mode`(read-only/workspace-write/danger-full-access) → UI 3모드 **Read-only / Auto / Full Access**.
- IDE는 **composer 바로 아래 항상 보이는 3-옵션 스위처**. TUI는 StatusLine에 표기 + `/permissions` 피커로 중간 전환.

**composer / 모델 / 컨트롤**
- `@` **통합 mention 피커**(파일/디렉/플러그인/스킬 퍼지 — 분리 affordance 없음) · `/` 슬래시(autocomplete) · `$` skills · `!` shell · **Tab=다음 턴 큐** · 턴 중 Enter=주입.
- 모델 피커 + **reasoning effort**(minimal→low→medium→high→xhigh)가 composer 아래 같은 행.
- **StatusLine**: model+reasoning · git branch · permissions · context% — 항목 토글형(`/statusline`).
- **진행 표시 = 스피너(100ms) + 경과 타이머 + interrupt 힌트**(진행률 바 없음).

**세션 / 히스토리 (★ 우리 §5-B/D2 청사진)**
- JSONL rollout(`~/.codex/sessions/YYYY/MM/DD/rollout-…jsonl`) + **SQLite 인덱스**(title=첫 user 메시지/토큰/git SHA·branch).
- `/resume`(피커: title·timestamp·cwd·tokens) · `/fork`(분기) · `/side`(임시) · `/new` · `/compact`(요약→`Compacted` 아이템). 재개 시 transcript/plan/승인/모델/sandbox 보존.
- **Goal mode** `/goal <objective>`: SQLite 영속, 상태 active/paused/budget_limited/complete + 토큰 예산 + 턴 넘어 자동 지속. (개념 참고 — 우리 OMC `/goal`과 별개.)

**설정**: `config.toml` 계층(CLI flag→project `.codex/`→profile→user→system→default). 핵심 키: `model`·`model_reasoning_effort`·`model_verbosity`·`approval_policy`·`sandbox_mode`·`[features]`(web_search/multi_agent/unified_exec…)·`[mcp_servers.*]`·`[tui]`(theme/vim/keymap.approval)·`[permissions.*]` named profile. 슬래시 ~40개.

**디자인 언어**: OpenAI Sans(ABC Dinamo), **monochrome/blue-grey accent(녹색 아님)**, 고밀도, monospace 전면, syntect 테마 ~32종 + **`/theme` 라이브 프리뷰**(arrow 시 샘플 즉시 리렌더). 시맨틱 TUI 색 슬롯(accent/assistant/user/success/warning/error/border/status). App엔 light/dark + 폰트/색 커스텀 + 테마 export.

**marudesk 차용 후보 (Top)**: ① **승인 모드 3-단계 스위처(composer 아래 + StatusBar 표기)** · ② **patch-preview 셀 → 최소 승인 모달** · ③ **세션(JSONL+인덱스) + 피커(title/time/cwd/tokens) + fork/compact** · ④ **reasoning verbosity(none/steps/full)** · ⑤ composer **overlay stack**(승인/피커/슬래시가 composer 대체 않고 위에 쌓임) · ⑥ `@` 통합 mention 피커(우리 capture/파일 첨부 통합) · ⑦ **스피너+경과타이머+interrupt 힌트** 진행 strip · ⑧ StatusLine 슬롯(model+reasoning·context%·permissions) · ⑨ `plan_update` → plan/todo 표면(§5-E).
**기각**: cloud delegation/worktree task(FREEZE) · multi-agent 병렬(단일 대화 유지) · config.toml 계층 전체(우린 GUI 설정 store) · Codex Pets · syntect 풀 테마 시스템(우린 Monaco/토큰).

### 4.4 종합 — 3-제품 공통 패턴 vs marudesk 갭 ✅

세 제품 **공통 합의(=업계 표준 기대)** 대비 marudesk **갭**(✅충족 / △부분 / ❌없음):
| # | 패턴 | Antigravity | Claude | Codex | marudesk | 갭 → 액션 |
|---|---|---|---|---|---|---|
| 1 | **세션/대화 히스토리 + 목록** | ✅ Inbox 스레드 | ✅ Recents/Projects | ✅ JSONL+SQLite /resume·/fork | ❌ 단일 대화 | **§5-B (D2)** ★최우선 공통 |
| 2 | **reasoning/Thinking 블록** | ✅ Thought 섹션 | ✅ 접이식+타이머 | ✅ verbosity | ❌ reasoning-delta 버림 | **§5-C** ★저위험 선두 (Phase4 잔여) |
| 3 | **풀 표면**(전용 모드/멀티 pane) | ✅ Agent Manager | ✅ Chat 탭 | ✅ App 3-pane | ❌ 380px 드로어 | **§5-A** ★탭 kind 승격 |
| 4 | **승인/자율성 모드** | ✅ 4 프리셋(2축) | △ 세션 스코프 카드 | ✅ Read/Auto/Full | △ 카드 1종, 모드 없음 | **§5-D** 모드 + preview 셀 |
| 5 | **plan/task artifact** | ✅ Task/Plan/Walkthrough | ✅ Artifacts(code/preview) | ✅ plan_update/Task Sidebar | ❌ | **§5-E** (plan 비-강제) |
| 6 | **검증 증거 표면** | ✅ Walkthrough(스샷/녹화) | — | ✅ Review pane | △ reload_and_verify 칩만 | **§5-E2** ★우리 wedge 증폭 |
| 7 | **에이전트 브라우저 오버레이** | ✅ 파란 커서 | — | — | ❌ (CDP는 있음) | **§5-E2** ★CDP로 우리만 |
| 8 | 진행 표시(스피너+경과 타이머) | ✅ 상태줄 | ✅ 5s 타이머 | ✅ +interrupt | △ StatusPill만 | **§5-G** 경과 타이머 |
| 9 | tool 호출 그룹/병합/타입 카드 | ✅ artifact 카드 | ✅ 동종 병합 | ✅ HistoryCell | △ 카드 1:1(타입별 ✅) | **§5-G** 연속 동종 병합 |
| 10 | composer `@`/`+` 컨텍스트 통합 | ✅ @멘션 | ✅ "+" 팝오버 | ✅ @ 통합/overlay | △ textarea + Captures 탭 | **§5-F** "+"/@ 통합 |
| 11 | "전체 에러 → 에이전트" | ✅ Send all | — | — | △ "Fix this" 1건 | **§5-E2** "Fix all" |
| 12 | 모델 셀렉터 | ✅ 드롭다운 | ✅ 상단 | ✅ +reasoning effort | ✅ model-first 콤보 | ≈패리티(effort 여지) |
| 13 | 디자인 정체성 | VS Code 다크 | warm/serif | mono/blue-grey | **Linear violet** | 유지 — accent만 신중 |

**핵심 결론:**
1. **공통 4대 갭** = 세션 히스토리(#1) · reasoning 블록(#2) · 풀 표면(#3) · 승인 모드(#4). 넷 다 v2 문서가 이미 "잔여(D2/Phase4/Codex 패리티)"로 지목 — **리서치가 v2 진단을 독립 검증.**
2. **marudesk wedge 검증 + 증폭(#6/#7/#11):** Antigravity의 시그니처(에이전트가 브라우저 몰고 → 스샷/녹화 검증 증거 + 파란 커서)는 **정확히 marudesk의 CDP 포지셔닝.** 시장 리더가 우리 thesis를 검증했다. → 차용 패턴이 곧 **차별점 증폭**: 검증-증거 artifact, 에이전트 브라우저 CDP 오버레이, "Fix all". *(positioning 보존: 일반 코딩 에이전트 경쟁 아님 — 우린 통합 로컬 + 런타임.)*
3. **디자인 정체성은 교체 안 함:** 세 제품 다 팔레트가 다르다(warm/mono/VS Code). marudesk의 **Linear violet**은 유지하고, *구조/정보구조/상호작용*만 패리티로 끌어올린다(색이 아니라 레이아웃이 "급"을 만든다).

## 5. 제안 — 우선순위 단계 (각 단계 typecheck + e2e 그린 + dogfood; 큰 폭포수 금지)

> 모든 항목 v2 FREEZE/positioning 준수: **단일 활성 대화**, CDP 차별점 보존·증폭, Linear violet 정체성 유지(구조만 패리티). 순서는 **위험↓·가치↑·의존성**으로 정렬 — v2의 "잔여" 목록과 일치.

### Phase A — reasoning/Thinking 블록 *(저위험·선두, Phase 4 잔여)* ✅완료 (tsc+build+e2e 6/6)
- **무엇:** [loop.ts:245](../electron/agent/loop.ts#L245) `fullStream`에서 `reasoning-delta`(+start/end) 캡처 → assistant 메시지에 `reasoning` 파트 누적 → [AgentChat.tsx](../src/features/agent/AgentChat.tsx) **접이식 "Thinking" 블록**(기본 접힘, `ai-thinking` peach 토큰 활용, 스트리밍 중 라이브). Anthropic은 `providerOptions.anthropic.thinking`(budget) 옵션, reasoning 내보내는 모델(o-series/deepseek 등)은 자동 표출.
- **왜 먼저:** 3-제품 공통(#2) + 데이터는 이미 스냅샷 투영 → **렌더러 + 백엔드 1지점 + shared 타입 1개**. 아키텍처 결정 불요. 단일 대화/FREEZE 무관.
- **검증:** AI SDK 타입(`reasoning-delta{id,text}` 확인됨) + e2e(Mock 스트림에 reasoning 파트 추가).

### Phase B — AI Chat 1급 표면(`agent` 탭 kind) + companion 드로어 보존 ✅완료 (e2e 7/7 + 스크린샷 감사)
- **무엇:** [registry.tsx](../src/features/tabs/registry.tsx)에 `agent` kind 1줄 + `AgentTab` 본문. **넓은 중앙 정렬 대화 컬럼**(Claude: prose 폭 제한, 비대칭 메시지, sticky composer+fog) + 우측 보조 레일 여지(Changes/Plan). `AgentChat`을 **폭 적응**(드로어 협소 / 탭 넓음) 공용 컴포넌트로. **드로어 모드 보존**(브라우저 옆 companion=positioning) + "탭으로 열기↗" 동선. 같은 단일 `state` 투영이라 둘은 같은 대화.
- **왜:** 풀 표면(#3)은 나머지(B/D/E)의 시각적 토대. 380px 드로어가 모든 카드/패널을 누름.
- **위험:** 중 — 탭 시스템/grid와 정합 필요(이미 kind 추상 존재 → 1곳 배선).

### Phase C — 세션 히스토리 (D2)
- **무엇:** main 모듈 `state`+`transcript` → `sessions: Map<id,{meta,state,transcript}>` + activeId + **디스크 영속**(JSONL/JSON, Codex 패턴 경량화). meta=title(첫 user 메시지)·model·timestamp·usage. UI: 세션 목록(드로어 헤더 또는 agent 탭 좌측 — Claude Recents / Codex 피커: title·time). 액션: New/Resume/Delete(+옵션 fork). **동시 실행 아님**(parking 부기 단순 — v2 결정).
- **왜:** 공통 #1(최우선 갭). reset()이 대화를 날리는 현 한계 해소.
- **위험:** 중-상 — 영속/마이그레이션. IPC(`agent:list-sessions`/`switch`/`delete`) 추가.

### Phase D — 승인/자율성 모드 (Codex/Antigravity)
- **무엇:** **Read-only / Auto / Full-auto** 토글(composer 근처 + StatusBar 표기). `GATED_TOOLS` 항상-승인을 모드로 일반화([loop.ts:310](../electron/agent/loop.ts#L310)) + 설정 영속. **patch-preview 셀 → 최소 승인 모달**(Codex: 증거는 transcript, 모달은 결정만). CDP `eval_js` 승인과 정합(차별점).
- **왜:** #4. "매일 믿고" 쓰기. 단, 우리 차별점인 런타임 도구 승인은 신중(Full-auto에서도 eval_js/nav는 확인 옵션 유지 고려).
- **위험:** 중 — 보안 표면(가드레일 불변 — allowlist/scrub 유지).

### Phase E — marudesk wedge 증폭 (CDP 차별점) ★포트폴리오 하이라이트
- **E1 plan/todo artifact(옵션, 비-강제):** 에이전트가 plan을 쓰면 Task List 카드(체크리스트). v2 결정 = 강제 게이트 아님.
- **E2 검증-증거 + 에이전트 브라우저 오버레이:** `reload_and_verify`/`get_console_errors`를 **before·after 콘솔/스크린샷 카드**(Antigravity Walkthrough급)로. 에이전트가 CDP로 페이지 조작 시 **타깃 DOM 파란 하이라이트 오버레이**(`Overlay.highlightNode` allowlist 확인). Console 패널 **"Fix all errors"**(현 "Fix this" 일괄). → "도는 앱을 보고 검증"을 *눈에 보이게*.
- **왜:** Antigravity가 검증한 wedge를 우리가 CDP로 더 통합되게. 차별점 가시화.

### Phase F — composer/컨텍스트 통합 + provider/온보딩
- composer **"+" 팝오버 / `@` 멘션**(Captures·열린 파일·CDP 컨텍스트·MCP 통합) → Captures 별도 탭 의존 완화. OAuth **"연결됨" 상태·계정** 채팅/헤더 노출 + **빈 상태 온보딩**(키/로그인 유도 — 신규 OAuth 기능 발견성). 모델 옆 reasoning-effort(옵션).

### Phase G — 디자인 폴리시 (단계마다 묻어서)
- **AI timeline 4색**(`ai-thinking/grep/read/edit`) 활성화 — tool 카드/타임라인. 진행 strip(**스피너+경과 타이머**, Claude/Codex 공통). **연속 동종 tool 호출 병합**(Claude "40 reads→1행"). hover-reveal 메시지 액션바(copy/revert). 카드 밀도/여백, 모션, light 테마 점검.

## 6. 마이그레이션 맵 (파일별, 단계별)

> 범례: ✏️ 변경 · ♻️ 재작성 · ➕ 신규 · ✅ 유지(영향 확인).

**Phase A (reasoning):**
| 파일 | 처리 | 내용 |
|---|---|---|
| `shared/agent.ts` | ✏️ | `AgentReasoningPart{type:'reasoning';text}` → `AgentPart` 유니온; (옵션) 파트별 `done` |
| `electron/agent/loop.ts` | ✏️ | `fullStream`에 `reasoning-delta`/`-start`/`-end` 처리(현 `text-delta`만, L245); (옵션) Anthropic thinking `providerOptions` |
| `src/features/agent/AgentChat.tsx` | ✏️ | `MessageView`에 reasoning 파트 → 접이식 `ThinkingBlock`(기본 접힘, peach) |
| `tests/e2e/*agent*` | ✏️ | Mock 스트림에 reasoning delta — 블록 렌더 검증 |

**Phase B (풀 표면):**
| 파일 | 처리 | 내용 |
|---|---|---|
| `src/features/agent/AgentTab.tsx` | ➕ | `agent` 탭 본문(넓은 레이아웃; `AgentChat` 임베드 + 보조 레일) |
| `src/features/tabs/registry.tsx` | ✏️ | `agent` kind(title/icon/render) 1줄 |
| `shared/browser.ts`(`TabKind`) | ✏️ | `'agent'` 추가 |
| `src/features/agent/AgentChat.tsx` | ♻️ | density prop(드로어/탭); 비대칭 메시지·prose 폭·sticky composer+fog |
| `src/features/context/ContextDrawer.tsx` | ✏️ | companion 유지 + "탭으로 열기↗" |
| `src/components/ActivityBar.tsx` / `TabStrip` | ✏️ | agent 탭 열기 엔트리/아이콘 |

**Phase C (세션):**
| 파일 | 처리 | 내용 |
|---|---|---|
| `electron/agent/sessions.ts` | ➕ | `Map<id,Session>` + 디스크 영속 + meta |
| `electron/agent/loop.ts` | ♻️ | 모듈 단일 `state`→활성 세션 참조; reset→새 세션 |
| `electron/agent/handlers.ts` · `shared/ipc.ts` | ✏️ | `agent:list/switch/delete-session` IPC |
| `shared/agent.ts` | ✏️ | `SessionMeta`; 스냅샷에 activeId/list |
| `src/features/agent/store.ts` · `SessionList.tsx` | ✏️/➕ | 목록 투영 + 전환 UI |

**Phase D (승인 모드):** `shared/agent.ts`(mode 타입)·`electron/agent/loop.ts`(게이팅 일반화)·`src/features/settings`(영속)·`AgentChat.tsx`(토글+patch-preview 셀)·`StatusBar.tsx`(표기).
**Phase E (wedge):** `src/features/agent/*`(plan/walkthrough 카드)·`electron/browser/cdp.ts`(`Overlay.highlightNode` allowlist 확인)·`src/features/devtools/panels/ConsolePanel.tsx`("Fix all").
**Phase F (composer/온보딩):** `AgentChat.tsx`(+/@ 팝오버)·`src/features/composer|context`(통합)·`ProvidersSettings.tsx`+빈상태 온보딩.
**Phase G (디자인):** `AgentChat.tsx`·`tokens.css`(필요 시)·tool 카드/타임라인·StatusPill(경과 타이머).

## 7. 비-목표 / 보존 (v2 계승)
- positioning: 차별점 = 런타임 CDP 도구. UX가 덮지 말고 드러낼 것.
- FREEZE: stagewise 게이트웨이/계정, Karton, history compression, 멀티 워크스페이스 mount, git worktree 표면, 범용 16-tool 풀세트, **동시 다중 에이전트 실행**(Antigravity Agent Manager의 병렬 실행은 *기각* — 단일 대화 유지; 단 "세션 목록" UI는 차용), plan 강제 게이트.
- 보안 불변: readFileSafe / applyPatch(atomic) / sendCdp(allowlist) / scrub.
- 에이전트 두뇌 자체제작 안 함 — provider 모델 사용.

---

### 부록 — 결정 로그
- **2026-06-01:** `/goal` — 신규 기능(OAuth·tool 카드·커스텀 엔드포인트) 안착 위한 화면/레이아웃 재배치 + AI Chat을 Antigravity/Claude/Codex Desktop 급으로. 3-제품 리서치(GitHub+웹) 병렬 착수. 현재 상태 teardown + 디자인 시스템 인벤토리 작성.
- **2026-06-01:** **3-제품 리서치 완료**(병렬 에이전트 3, 각 ~75–83k tok). §4.1 Antigravity(Agent Manager/artifacts/브라우저 서브에이전트=우리 CDP wedge 검증) · §4.2 Claude(비대칭 메시지/Thinking/+팝오버/warm-serif) · §4.3 Codex(승인 3모드/세션 JSONL+SQLite/reasoning verbosity/overlay stack) 종합. **§4.4 공통 4대 갭 = 세션·reasoning·풀표면·승인모드**(v2 "잔여" 독립 검증) + **wedge 증폭**(검증증거/브라우저 오버레이/Fix all). **§5 7단계 우선순위 + §6 마이그레이션 맵 확정.**
- **2026-06-01: Phase A 완료** — reasoning/Thinking 블록. `shared/agent.ts` `AgentReasoningPart` + `loop.ts` `reasoning-delta` 캡처(display-only, transcript 미포함) + `AgentChat.tsx` `ThinkingBlock`(접이식, peach `ai-thinking`, 스트리밍 라이브). tsc+build+e2e 6/6 그린. (구현 중 live-edge 버그 1개 발견·수정: 루프가 빈 text part를 항상 seed → `lastTextIdx===-1` 불가 → `streaming && hasReasoning && answerText===''`로 교체.)
- **2026-06-01: Phase B 구현** — 풀 표면 `agent` 탭 kind. `shared/browser.ts` `FEATURE_KINDS += 'agent'`(→ TabKind/FeatureKind 자동 확장; main `FEATURE_TITLES`/`isTabKind` + 렌더러 `PaneHeader` KIND_ICON/LABEL의 complete-Record들이 컴파일 타임에 누락 강제 — 전부 채움) + `registry.tsx` agent 엔트리 + 신규 `AgentTab.tsx`(AgentChat `variant="full"` — 중앙 정렬 max-w-3xl prose 컬럼) + `AgentChat` `variant:'drawer'|'full'` prop. 드로어 companion 보존 + 헤더 "탭으로 열기"(Maximize2) + `openAgentTab()` + HomeView "AI Chat" 런처(2×2). 같은 단일 state 투영(대화 분기 없음). **검증 완료:** tsc+build+e2e 7/7(신규 "Home 런처→AI Chat 탭" 테스트 + tabs/grid/smoke 무회귀); 합성 `agent:event` 스냅샷 스크린샷 감사 → full surface 중앙 정렬·Thinking 블록·tool 카드·Changes 정상. 추가 폴리시: 모델바도 full에서 `max-w-3xl` 중앙 정렬(드롭다운 앵커를 inner `relative`로 이동). 발견: `ContextDrawer`는 닫혀도 마운트 유지 → 드로어+탭의 AgentChat 2개가 같은 단일 대화를 투영(정상; e2e는 `<main>`으로 스코프).
