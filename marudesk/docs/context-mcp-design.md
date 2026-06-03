# Context MCP — built-in, on-demand context for AI Chat (v5)

> 후속: [agentic-chat-v4-design.md](./agentic-chat-v4-design.md). v4가 §B에서 "in-process 컨텍스트
> 툴 → (future) 외부 MCP"의 단계를 깔았고, §B5에서 **"in-process 레지스트리를 '로컬 MCP
> provider'로 추상화해 두면 외부 MCP가 같은 머지 지점에 꽂힌다"** 고 적었다. v5는 그 추상화를
> 실제로 만들고, 사용자가 요청한 컨텍스트 소스를 전부 채운다:
> **브라우저 / 터미널 / 파일 탐색기 / 이전 세션 / 메모리 / DevTools / 다른 탭**.
>
> 작성: 2026-06-01. 확정 방향(사용자 지시): "AI가 원할 때 가져올 수 있는 mcp를 만들고,
> **우리 AI Chat에 기본 내장**한다."

---

## 0. 핵심 결정 (왜 in-process 'local MCP provider'인가)

- **`ai` SDK v6의 MCP 클라이언트(`experimental_createMCPClient`)는 도구에 `execute`를 붙여
  자동 실행한다.** 그런데 marudesk 루프는 일부러 `execute`를 안 붙이고
  ([model.ts `aiTools`](../electron/agent/model.ts)) 각 tool call을 루프로 되돌려받아
  **승인(approval)/`ask_user` 파킹/edit 기록/read-only 모드**를 직접 중재한다. SDK MCP 클라이언트를
  그대로 쓰면 이 통제가 전부 깨진다.
- 따라서 **내장 MCP는 in-process이면서 루프가 실행을 중재**해야 한다. 외부 프로토콜 transport는
  지금 도입하지 않는다(의존성·왕복 비용·ctx 전달 문제). 대신 **MCP 서버의 형태(이름 있는 서버,
  네임스페이스 툴, JSON-Schema, list/call 인터페이스, read-only 성격)를 그대로 가진
  `McpServer` 추상화**를 만든다. 이게 "내장 MCP"다.
- 이 추상화의 이점: ① 사용자의 "mcp 내장" 요청을 형태 그대로 만족, ② v4 §B5의 머지 지점을 실제로
  구현 → 나중에 외부 stdio/remote MCP를 **같은 `McpServer` 인터페이스**로 꽂으면 끝, ③ 기존 루프
  불변식(승인/transcript 유효성) 보존.

---

## 1. 타깃 구조 (target structure)

```
electron/agent/
  mcp/
    types.ts        # McpToolDef, McpServer, McpRegistry — 추상화의 한 점
    registry.ts     # 서버들을 모아 listTools()/callTool()/메타 도출 (gated/write)
    builtin.ts      # 내장 'marudesk' 컨텍스트 서버: 모든 소스 그룹을 조립
    sources/
      files.ts      # read_file/list_files/grep/edit_file/multi_edit (기존 tools.ts에서 이관)
      browser.ts    # list_tabs(web)/read_page/query_dom/eval_js/cookies/storage + reload_and_verify
      devtools.ts   # read_console(레벨필터)/read_network/read_network_body  (CDP + 렌더러 미러)
      terminal.ts   # list_terminals/read_terminal(by id)
      tabs.ts       # list_tabs(전체 종류)/read_editor  (렌더러 미러)
      sessions.ts   # list_sessions/read_session         (신규 영속화)
      memory.ts     # list_memory/read_memory/write_memory (신규 기능)
  context-cache.ts  # 렌더러→메인 미러 캐시(탭/에디터/탐색기/devtools console)
  sessions-store.ts # 완료 대화 transcript를 userData에 영속화
  memory-store.ts   # userData 메모리 엔트리(markdown) 저장소
  tools.ts          # (얇아짐) ToolContext/ToolResult/scrub helper만 남기거나 sources로 분해
  loop.ts           # registry로 tools 빌드 + callTool 라우팅 (TOOL_SCHEMAS/EXECUTORS 대체)
```

신규 공유/렌더러:
```
shared/
  context.ts        # context:sync 페이로드 타입(탭/에디터/탐색기/console 미러)
  sessions.ts       # SessionRecord/SessionSummary 타입
  memory.ts         # MemoryEntry 타입
src/features/agent/
  context-sync.ts   # 렌더러 스토어 슬라이스를 main으로 debounce push 하는 훅
```

### 1.1 `McpServer` 추상화 (the one merge point)

```ts
// electron/agent/mcp/types.ts
export type McpToolDef = {
  name: string;            // 안정적 이름(내장) / 외부는 <server>_<tool>로 네임스페이스
  description: string;
  inputSchema: object;     // JSON Schema (Anthropic input_schema)
  group: McpGroup;         // 'files'|'browser'|'devtools'|'terminal'|'tabs'|'sessions'|'memory'|'ask'
  gated?: boolean;         // 호출당 승인 필요(쿠키/스토리지/eval/터미널)
  write?: boolean;         // 워크스페이스/상태 변경 → read-only 모드에서 거부
  requiresWeb?: boolean;   // 활성 web 탭 필요
  requiresWorkspace?: boolean;
};

export interface McpServer {
  readonly name: string;                 // 'marudesk'(내장) | 외부 서버 id
  listTools(): McpToolDef[];
  callTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult>;
}
```

루프는 `registry.listTools()`로 전체 도구를 모아 `aiTools()`에 넘기고(여전히 execute 없음),
tool call이 오면 `registry.callTool(name, input, ctx)`로 라우팅한다. `GATED_TOOLS`/`WRITE_TOOLS`
상수는 `def.gated`/`def.write`에서 **도출**된다(단일 진실원).

---

## 2. 컨텍스트 소스 → 도구 매핑 (사용자 요청 7종 전부)

| 사용자 요청 | 도구(내장 'marudesk' 서버) | 데이터 출처 | 신규? |
|---|---|---|---|
| 브라우저 내용 | `list_tabs`(web), `read_page`(가시 텍스트), `query_dom`, `eval_js`⚠, `browser_cookies`⚠, `browser_storage`⚠, `reload_and_verify` | main: `tabValues()`/CDP `sendCdp` | read_page/list_tabs 신규, 나머지 기존 |
| 터미널 내용 | `list_terminals`, `read_terminal`(id 지정)⚠ | main `terminal.ts` `sessions` 맵 | 열거/by-id 신규 |
| 파일 탐색기 내용 | `list_files`, `read_file`, `grep`, `read_explorer`(확장/선택 상태) | main 인덱스 + 렌더러 미러 | read_explorer 신규 |
| 이전 세션 기록 | `list_sessions`, `read_session` | **신규** `sessions-store.ts`(userData) | 신규 |
| 메모리 | `list_memory`, `read_memory`, `write_memory` | **신규** `memory-store.ts`(userData) | 신규 |
| DevTools 내용 | `read_console`(log/warn/error 레벨필터), `read_network`, `read_network_body` | main 에러버퍼 + 렌더러 devtools console 미러 + CDP | read_console 확장 |
| 다른 탭의 내용 | `list_tabs`(전 종류) + 종류별: web→`read_page`, editor→`read_editor`(미저장 포함), terminal→`read_terminal` | main(web) + 렌더러 미러(editor/탭목록) | read_editor/전체 list_tabs 신규 |

⚠ = `gated`(호출당 승인; read-only/auto 모드 규칙은 v4 §B4 그대로).

모든 페이지/터미널/에디터 텍스트는 **egress에서 `scrubText`** 통과(현행 유지).

---

## 3. 메인↔렌더러 브릿지 (가장 큰 제약)

- **사실:** 에이전트 루프는 main에서 돈다. main은 web 탭(WebContentsView)·콘솔 에러·네트워크·
  워크스페이스 파일·CDP·터미널 스크롤백을 **직접** 본다. 하지만 **main이 렌더러에 데이터를
  요청(request/response)하는 경로가 없다** — `webContents.send`(단방향 push)만 있다.
- 렌더러 전용 상태: 전체 탭/스플릿 목록(editor/terminal/settings/home/agent 종류), **에디터 버퍼
  (미저장 내용)**, 탐색기 트리 상태, devtools 스토어(전 레벨 console 등).
- **해결(미러링):** 렌더러가 관련 스토어 슬라이스를 **변경 시 debounce하여 main으로 push**
  (`context:sync` invoke 핸들러 — 결과는 무시). main `context-cache.ts`가 최신 스냅샷을 보관.
  MCP 툴은 캐시 + main 직보유 상태를 합쳐 읽음. (역방향 request/response를 새로 만드는 것보다
  단순·기존 아키텍처와 정합. 캐시는 bounded; 미러는 raw, 스크럽은 툴 egress.)
- 페이로드(`shared/context.ts`): `{ tabs: TabState[]; activeTabId; editors: {path; dirty; content}[];
  explorer: {expandedDirs; selectedPath; root?}; console?: ConsoleMirror[] }`. 크기 상한 적용.

---

## 4. 신규 영속화

### 4.1 Sessions (이전 세션 기록)
- 대화가 끝나면(`loop.finish('completed')` 등 종결 + 메시지≥1) transcript 스냅샷을
  `userData/sessions/<id>.json`에 저장(`SessionRecord`: id, title(첫 user 메시지 요약),
  createdAt, model/provider, messages(표시용 parts), usage). 상한 개수(예: 200) 넘으면 오래된 것 prune.
- `reset()`(새 대화) 직전에도 현재 대화가 비어있지 않으면 저장 → "이전 세션"이 쌓인다.
- 툴: `list_sessions`(최근순 요약), `read_session(id)`(표시용 텍스트로 평탄화, 스크럽).
- (옵션 UI) v3 Phase C의 세션 목록은 후속. 이번엔 영속화 + MCP 접근까지.

### 4.2 Memory (메모리)
- 사용자가 잘 아는 Claude Code 메모리 모델을 차용: `userData/marudesk-memory/<slug>.md`,
  소형 frontmatter(`name`, `updatedAt`) + 본문. `index.json`로 빠른 열거.
- 툴: `list_memory`, `read_memory(name)`, `write_memory(name, body)`(=`write`; read-only 모드 차단,
  ask/auto는 허용 — 워크스페이스 파일이 아니라 앱 내부 상태라 호출당 승인까진 안 둠).
- AI가 대화 간 지속되는 사실을 적고 다음 턴/세션에 다시 읽을 수 있다.

---

## 5. 마이그레이션 맵 (파일별)

**추가**
- `electron/agent/mcp/{types,registry,builtin}.ts` + `sources/{files,browser,devtools,terminal,tabs,sessions,memory}.ts`
- `electron/agent/{context-cache,sessions-store,memory-store}.ts`
- `shared/{context,sessions,memory}.ts`
- `src/features/agent/context-sync.ts`

**수정**
- `electron/agent/tools.ts` — 실행 로직을 `mcp/sources/*`로 이관, 공용 helper/타입만 잔류(또는 re-export).
- `electron/agent/loop.ts` — `TOOL_SCHEMAS`/`GATED_TOOLS`/`WRITE_TOOLS`/`executeTool` → `registry` 경유.
  종결 시 세션 저장 훅.
- `electron/agent/model.ts` — `aiTools`는 `McpToolDef[]`도 받게(현 `ToolSchema[]`와 호환 시그니처).
- `electron/terminal.ts` — `getTerminalList()`, `getTerminalOutput(id, max)` 추가.
- `electron/browser/state.ts` — (필요시) 전 web 탭 열거는 이미 `tabValues()`로 가능.
- `electron/main.ts` — `context:sync` 핸들러 등록, sessions/memory 스토어 init(userData 경로).
- `shared/ipc.ts` — `context:sync` invoke 채널 + (옵션) `context:mcp-list` 추가.
- `src/features/agent/AgentChat.tsx` — 새 도구들 `TOOL_META`(아이콘/라벨), 컴포저 "+" 메뉴에
  "Built-in context (marudesk MCP)" 섹션 노출(켜져 있음 표시).
- `src/views/Shell.tsx` 또는 앱 루트 — `context-sync` 훅 마운트.
- `electron/agent/tools.ts` 시스템 프롬프트(loop.ts `SYSTEM_PROMPT`) — 새 컨텍스트 도구 안내.

**제거**: 없음(이번 라운드). 기존 도구 이름 유지(테스트/transcript 안정성).

---

## 6. 단계 계획

| 단계 | 내용 | 상태 |
|---|---|---|
| **P1** | Explorer 드래그-투-클로즈 (close-zone 어포던스 + 복원 폭) | ✅ done |
| **P2** | Provider/Model 피커 리디자인 (이모지 별→`Star`, 프로바이더 모노그램 글리프+브랜드색, capability 색=AI-timeline hue, experimental 배지 통일) | ✅ done |
| **P3** | MCP 추상화: `mcp.ts`(`McpServer`/registry), 기존 도구를 `BUILTIN_TOOLS`로, 루프가 `listMcpTools`/`callMcpTool`/`isGated`/`isWrite` 경유 | ✅ done (동작 무변) |
| **P4** | main-side 소스: `list_tabs`(web)/`read_page`(any tab), `list_terminals`/`read_terminal`(by id) | ✅ done |
| **P5** | 렌더러→main 미러(`context-cache`+`context:sync`+`context-sync.ts` 훅, Shell 마운트), `read_editor`(미저장 포함)/`read_explorer` | ✅ done |
| **P6** | Sessions 영속화(`sessions-store.ts`, finish/reset 훅) + `list_sessions`/`read_session` | ✅ done |
| **P7** | Memory 스토어(`memory-store.ts`, md-per-entry) + `list_memory`/`read_memory`/`write_memory` | ✅ done |
| **P8** | 와이어업: `TOOL_META` 아이콘(신규 11종), 시스템 프롬프트, 컴포저 "+"에 "Built-in context · MCP" 섹션 | ✅ done |
| **P9** | 검증: typecheck 0 / lint 0 / build OK / e2e 52 통과; 문서·메모리 업데이트 | ✅ done |

각 단계는 컴파일 가능 상태 유지. P3는 리팩터(동작 무변), P4~P7은 도구 추가, P8은 UI 노출.

### 6.1 구현 노트 (실제 랜딩 형태)
- **내장 MCP = in-process `McpServer`** (`electron/agent/mcp.ts`): builtin 서버 `marudesk`가
  `BUILTIN_TOOLS`(tools.ts, 기존) + `CONTEXT_TOOLS`(context-sources.ts, 신규 11종)을 노출.
  `registerMcpServer()`가 외부 MCP 머지 지점(미사용, B5용). 루프는 schema-only로 등록(`aiTools`,
  execute 없음) → 승인/ask_user/read-only 중재 유지. `gated`/`write`는 descriptor 플래그에서 도출.
- **다른 탭의 내용**: `sendCdp`가 lazy-attach라 `read_page`/query가 활성 탭이 아닌 **임의 web 탭**도
  읽음(Chromium DevTools가 클라이언트를 잡은 탭은 친절 에러). `list_tabs`는 main `tabValues()`에서
  전 종류 탭(웹/에디터/터미널/…)을 열거.
- **브릿지**: editor 미저장 버퍼 + explorer 트리 상태만 렌더러→main(`context:sync`, debounce 400ms,
  Shell의 `useContextSync`)으로 미러. 나머지(웹/터미널/세션/메모리)는 main 직접.
- **Sessions/Memory 신규 영속화**: `userData/sessions/{index.json,<id>.json}`,
  `userData/marudesk-memory/<slug>.md`. 세션은 대화별 stable id로 매 턴 finish에서 갱신 저장.
- **남은 것(후속)**: 세션/메모리 브라우징 UI(현재는 MCP 접근만), devtools 전 레벨 console 미러,
  멀티모달 page screenshot, 원격 MCP OAuth 인증. (외부 MCP transport는 §8에서 stdio + 원격
  HTTP/SSE로 고도화됨.)

## 7. Non-goals
- 세션/메모리 풀 UI(브라우징·편집 패널)는 최소만. MCP 접근이 이번 핵심.
- 멀티모달(스크린샷) 페이지 캡처 — 후속.
- OAuth 기반 원격 MCP 인증 흐름(authProvider) — 지금은 정적 `headers`(예: `Authorization`)만. 후속.

---

## 8. 외부 MCP 고도화 (remote transport · trust · 헬스)

> v5가 §0/§B5에서 깔아둔 `McpServer` 머지 지점 위에서 외부 커넥터를 실사용 가능한 수준으로
> 보완·고도화한다. **루프 불변식(승인/read-only/ask_user 중재)은 그대로** — 외부 도구는 여전히
> `client.callTool`을 우리가 직접 호출하는 plain 도구다(SDK 자동실행 클라이언트 미사용).

### 8.1 원격(HTTP) 트랜스포트
- 기존: stdio(로컬 프로세스)만. 추가: **Streamable HTTP**(현행 스펙 트랜스포트) + **SSE**(레거시) 폴백.
- 설정(`mcp-servers.json`)이 트랜스포트별 판별 유니온이 된다:
  - stdio(기본): `{ id, command, args?, env?, enabled }` — `transport` 생략 또는 `'stdio'`.
  - http: `{ id, transport: 'http'|'sse', url, headers?, enabled }`.
- `transport: 'http'`는 Streamable HTTP를 먼저 시도하고 실패 시 SSE로 graceful 다운그레이드.
  `transport: 'sse'`는 바로 SSE. `headers`(예: `Authorization`)는 모든 요청에 실리며 **로그 금지**.
- 하위호환: `transport` 없는 기존 stdio 엔트리는 그대로 동작. `command` 없이 `url`만 있으면 http로 추론.
- `sanitizeMcpConfig`가 트랜스포트별로 검증: http 엔트리는 http(s) URL 필수(아니면 drop).

### 8.2 신뢰(trust)와 도구 필터(disabledTools)
- `trust: true` → 그 서버의 도구는 **gated 해제**(호출당 승인 생략, read-only/auto 규칙은 유지).
  사용자가 직접 통제·신뢰하는 서버에만. 기본은 `false`(third-party는 호출당 승인).
- `disabledTools: string[]` → 서버의 특정 도구(자기 이름 기준)를 **모델에 아예 노출 안 함**.

### 8.3 헬스(crash detection)
- 연결 성공 후 트랜스포트가 비정상 종료(프로세스 exit/네트워크 끊김)하면 클라이언트 `onclose`로 감지 →
  죽은 도구를 unregister 하고 상태를 `error('connection closed')`로 표시. 의도적 teardown은 `onclose`를
  먼저 떼므로 오발 안 함.

### 8.4 Settings 표면
- `McpServerStatus`에 `transport`/`target`(시크릿 제거된 엔드포인트 라벨: command 또는 URL origin+path)/
  `trusted`/`tools`(노출 도구 이름) 추가. Settings → MCP Servers가 트랜스포트 아이콘, Trusted 배지,
  연결 시 도구 목록을 렌더.

### 8.5 검증
- `npm run harness:mcp` — sanitize(유니온/trust/disabledTools/URL drop/중복), buildExternalServer(trust→
  ungated, disabledTools 필터), 상태 필드(transport/target/trusted/tools), crash(onclose), 그리고 **실제
  Streamable HTTP 왕복**(in-proc mock HTTP 서버 `mcp-mock-http-server.ts` 대상)까지 62개 assertion.
- `npm run typecheck` / `npm run lint` / `npm run build` 통과.
