# Plugin Runtime — 사용자 커스터마이징을 위한 격리 JS 플러그인 (v1 설계)

> 작성: 2026-06-04. 확정 방향(사용자 지시): "플러그인 기능을 만들어 사용자가 커스터마이징할 수
> 있게 한다." 격리 방식 = **Electron `utilityProcess`**, 첫 산출물 = **본 설계 문서**.
>
> 선례: [context-mcp-design.md](./context-mcp-design.md)가 만든 **`McpServer` 추상화**와
> `electron/agent/mcp-external.ts`의 **외부 stdio MCP 커넥터**. 플러그인 런타임은 새 시스템을
> 통째로 만드는 대신, 이 두 선례 위에 **"플러그인 = 격리 프로세스에서 도는 합성 MCP 서버 +
> 추가 기여 포인트"** 로 얹는다.

---

## 0. 핵심 결정 (왜 이 형태인가)

- **플러그인 JS는 main 프로세스에서 절대 직접 실행하지 않는다.** Electron에서 신뢰 경계를 깨는
  1순위 실수가 서드파티 코드를 main의 V8(=Node 전권 + Electron API)에서 `require`/`eval`하는
  것이다. 플러그인 코드는 전부 **`utilityProcess`(Electron이 제공하는 격리 Node 자식 프로세스)**
  에서 돌고, 바깥 세상과는 **`MessagePort`의 구조화 메시지로만** 소통한다.
- **도구(tool) 기여는 기존 중재 경로를 그대로 탄다.** marudesk 루프는 일부러 도구에 `execute`를
  안 붙이고 각 tool call을 루프로 되돌려받아 **승인/`ask_user`/read-only/edit 기록**을 중재한다
  ([loop.ts](../electron/agent/loop.ts), [mcp-external.ts](../electron/agent/mcp-external.ts)).
  플러그인이 등록한 도구도 **플러그인당 1개의 합성 `McpServer`** 로 `registerMcpServer`에 꽂으면,
  네임스페이싱·gating·승인·graceful 실패가 **공짜로** 동일 적용된다. 외부 MCP와 같은 머지 지점.
- **권한은 매니페스트 선언 + 설치 시 사용자 승인(capability-based).** 플러그인은 자기가 필요한
  능력(`fs:read`, `fs:write`, `net`, `tools`, `commands`, …)을 `manifest.json`에 선언하고,
  사용자가 설정에서 명시적으로 승인해야 활성화된다. host는 선언+승인되지 않은 능력의 RPC를
  **무조건 거부**한다(기본 거부). 플러그인은 Node `fs`/`net`을 직접 못 부르고, **host가 중개하는
  `ctx.fs`/`ctx.http`** 로만, 그것도 권한·경로·도메인 가드를 통과한 것만 쓴다.
- **렌더러 UI 기여는 v1 비목표.** 임의 JS로 패널을 그리려면 샌드박스된 뷰(별도 `webContents` +
  CSP + 권한)가 필요해 보안 비용이 크다. v1은 **헤드리스 기여(도구 + 슬래시 커맨드)** 만 다루고,
  UI 패널 기여는 v2로 분리한다(§9).

---

## 1. 타깃 구조 (target structure)

```
shared/
  plugin.ts            # 전송-안전 타입: PluginManifest, PluginPermission, PluginRecord,
                       #   PluginStatus, PluginRpc 메시지(host↔worker), Contribution 페이로드
electron/
  plugins/
    manager.ts         # 스캔/매니페스트 파싱/권한 상태/생명주기/합성 McpServer 등록·해제
    host.ts            # utilityProcess 1개 = 1 플러그인. spawn/teardown + 타입드 RPC 브리지
    rpc.ts             # PluginRpc 프레이밍·요청/응답 상관·타임아웃 (host ↔ worker 공통 계약)
    permissions.ts     # capability 가드: fs(루트/never-edit glob)·net(도메인 allowlist) 검사
    worker.ts          # ⚠ utilityProcess 진입점. 플러그인 모듈 로드 → activate(ctx) → ctx 구현
    handlers.ts        # ipcMain: plugins:list / enable / disable / reload / grant / revoke
    config.ts          # userData의 플러그인 활성/권한 상태 영속화(JSON), 외부 MCP config와 동형
  agent/
    slash-registry.ts  # (신규) 빌트인 + 플러그인 슬래시 커맨드를 합치는 동적 레지스트리
src/features/settings/
  PluginsSettings.tsx  # 목록·활성토글·권한 칩·승인/취소·리로드·에러 표시 (McpServersSettings 형제)
docs/
  plugin-runtime-design.md   # 본 문서
```

스캔 스코프는 **Skills와 동일**( [skills-store.ts](../electron/agent/skills-store.ts) 참고, project가
name 충돌 시 user를 가린다):

- user:    `<userData>/plugins/<id>/`
- project: `<workspace>/.marudesk/plugins/<id>/`

각 플러그인 폴더:

```
<id>/
  manifest.json    # 신뢰된 스캔으로만 읽음 (모델/플러그인 입력으로 경로를 만들지 않는다)
  index.js         # CommonJS 진입점. module.exports = { activate, deactivate? }
  README.md        # (선택)
```

### 1.1 `McpServer` 추상화 위에 얹기 (the merge point)

[mcp.ts](../electron/agent/mcp.ts)의 `registerMcpServer(server: McpServer)` 가 단일 머지 지점이다.
매니저는 플러그인이 활성화될 때 **그 플러그인의 도구만 담은 `McpServer`** 를 만들어 등록한다:

- 서버 이름/네임스페이스: `plugin:<id>` → 도구는 `plugin:<id>__<tool>` (외부 MCP의 `<id>__<tool>`과
  동형).
- 각 도구의 `exec`는 **host RPC** 로 위임한다: `exec(input)` → worker의 `callTool` → 결과를
  `ToolResult`로 매핑. 외부 MCP가 `client.callTool`로 위임하는 것과 정확히 같은 모양.
- 메타데이터: `group: 'plugin'`(신규 `McpGroup` 값), `gated: true` 기본(서드파티·부작용 가능),
  `write: false`(gating으로 통제 — 외부 MCP와 동일 근거).

이 덕분에 loop/approval/transcript 불변식은 **0줄 수정**으로 보존된다(매니저가 등록만 한다).

---

## 2. 매니페스트 스키마 (`manifest.json`)

```jsonc
{
  "id": "hello-world",            // [a-z0-9-], 폴더명과 일치 강제
  "name": "Hello World",
  "version": "1.0.0",             // semver (표시용)
  "description": "예제 플러그인",
  "main": "index.js",             // 폴더 기준 상대경로, 폴더 밖 이탈 금지
  "engine": { "marudesk": "^1.0.0" }, // 호스트 API 버전 — 불일치 시 비활성 + 경고
  "permissions": [
    "tools",                      // registerTool 사용
    "commands",                   // registerSlashCommand 사용
    "fs:read",                    // ctx.fs.read* (워크스페이스 루트 안 + never-edit glob 존중)
    "fs:write",                   // ctx.fs.write* (위와 동일 가드)
    "net"                         // ctx.http.fetch (net.allow 도메인만)
  ],
  "net": { "allow": ["api.example.com"] } // permissions에 "net" 있을 때만 의미
}
```

검증 규칙(파싱은 신뢰 스캔에서만, 실패는 graceful):

- `id`가 폴더명과 다르거나 슬러그 규칙 위반 → 스킵 + `error` 상태.
- `main`이 `..`로 폴더를 벗어나면 → 거부.
- 모르는 permission 문자열 → 무시(앞으로의 확장 호환), 단 알 수 없는 능력은 부여 안 됨.
- `engine.marudesk`가 호스트 API semver와 불일치 → 로드 안 하고 사용자에게 표시.

---

## 3. 격리 모델 — `utilityProcess` + RPC 브리지

```
main (manager.ts / host.ts)                 utilityProcess (worker.ts)
  registerMcpServer(plugin:<id>)              require(main) → activate(ctx)
        │  exec(input)                                 │
        ├──────── RPC: {callTool,name,input} ─────────▶│ ctx.<tool>.handler(input)
        │◀─────── RPC: {result | error} ──────────────┤
        │                                              │
   ctx.fs / ctx.http 중개                       ctx.fs.read(path) ── RPC ──▶ host 권한검사 ──▶ 결과
```

- **spawn:** `utilityProcess.fork(worker.js, [pluginDir], { stdio: 'pipe', serviceName: 'plugin:<id>' })`.
  `worker.js`는 우리 번들 산출물(플러그인 코드 아님); 플러그인 `index.js`는 worker가 *그 안에서*
  `require`한다. 환경변수/`process.env`는 비우고, `cwd`는 플러그인 폴더로 한정.
- **RPC 계약([rpc.ts](../electron/plugins/rpc.ts)):** 길이-상관 ID가 붙은 단방향 메시지 양방향.
  - host→worker: `load`, `callTool{name,input}`, `runCommand{name,arg}`, `deactivate`.
  - worker→host: `ready{contributions}`, `result{id,...}`, `error{id,...}`, `log{level,msg}`,
    그리고 **권한 RPC** `fs.read/fs.write/http.fetch`(host가 응답).
  - 모든 페이로드는 구조화-복제 가능한 JSON만(함수/클래스 전달 금지).
- **타임아웃:** `callTool`/`runCommand`는 외부 MCP와 동일하게 60s, `load`/`ready`는 10s. 초과 시
  그 호출만 실패로 매핑(프로세스는 살림), 반복 실패/크래시는 플러그인 비활성 + `error`.
- **크래시 격리:** worker가 죽어도 host가 잡아 `error` 상태로 전이하고 앱은 안 죽는다(외부 MCP의
  graceful 실패 원칙 그대로). 기본 동결: config가 비면 아무것도 spawn하지 않아 **inert 출하**.

### 3.1 플러그인이 보는 API — `ctx` (worker.ts가 구현)

```ts
type PluginContext = {
  registerTool(def: {
    name: string;                 // 슬러그, 플러그인 내 유일
    description: string;
    inputSchema: JSONSchemaObject; // type:'object' 형태만
    handler(input: unknown): Promise<string | { text: string }>;
  }): void;
  registerSlashCommand(def: {
    name: string; description: string; argHint?: string;
    expand(arg: string): string;  // prompt 커맨드만 (action 커맨드는 v1 비허용 — 렌더러 권한)
  }): void;
  fs: {                           // "fs:read"/"fs:write" 권한 필요. 전부 host가 가드.
    read(relPath: string): Promise<string>;
    write(relPath: string, data: string): Promise<void>;
    list(relPath: string): Promise<string[]>;
  };
  http: { fetch(url: string, init?): Promise<{ status: number; text: string }> }; // "net"
  log(...args: unknown[]): void;  // host로 포워딩 → 설정 패널 로그
};
```

`registerTool`/`registerSlashCommand`는 **`activate` 동안에만** 호출 가능(동기 수집). worker는
수집한 기여 목록을 `ready`로 host에 보고하고, host는 그걸로 합성 McpServer/슬래시 항목을 만든다.

---

## 4. 권한 가드 ([permissions.ts](../electron/plugins/permissions.ts))

기본 거부. host는 worker의 모든 권한 RPC에 대해:

- **`fs:*`** — `relPath`를 활성 워크스페이스 루트로 resolve하고 **루트 밖 이탈 거부**, 기존
  **never-edit glob**([workspace-config.ts](../electron/workspace-config.ts))을 `fs:write`에 적용,
  심볼릭 링크는 realpath로 재검사. 권한 미선언/미승인이면 즉시 거부.
- **`net`** — `url` 호스트가 `manifest.net.allow` allowlist에 정확히 매치할 때만. 사설/loopback
  IP·리다이렉트 호스트 변경 차단. 응답 본문은 상한(예: 1MB)으로 자른다.
- 모든 거부는 worker에 명시적 `error`로 돌려 플러그인이 처리하게 한다(조용한 무시 금지).

승인 UX: 설치/활성화 시 설정 패널이 **선언된 permissions를 칩으로 보여주고** 사용자가 승인해야
`enabled`가 된다. 권한 변경(매니페스트 수정으로 새 권한 등장)은 **재승인**을 요구한다.

---

## 5. 슬래시 커맨드 동적 레지스트리

현재 [shared/slash-commands.ts](../shared/slash-commands.ts)는 **정적 배열** `SLASH_COMMANDS`이고
렌더러가 `filterSlash`/`slashQuery`로 직접 읽는다. 플러그인 커맨드를 끼우려면:

- `shared/slash-commands.ts`는 **빌트인 목록 + 순수 헬퍼**로 유지(전송-안전).
- 신규 [agent/slash-registry.ts](../electron/agent/slash-registry.ts)(main) 또는 렌더러 스토어가
  `builtin ++ pluginCommands`를 합쳐 노출. 플러그인 커맨드는 `kind:'prompt'`만(렌더러 `action`은
  권한 위임 위험 → v1 비허용). 플러그인 prompt 커맨드는 네임스페이스 표기(예: `/myplugin:foo`)로
  빌트인과 충돌을 피한다.
- 렌더러는 main에서 `plugins:commands` 스냅샷을 받아 기존 메뉴에 머지(별도 IPC, 1방향).

> 주의: `expand(arg)`는 **문자열을 만들 뿐 실행하지 않는다**. 결과 prompt는 일반 턴으로 들어가
> 평소의 도구 승인 흐름을 다시 탄다. 그래서 슬래시 기여는 도구 기여보다 위험이 낮다.

---

## 6. 마이그레이션 맵 (파일별, 구현 단계에서)

| 파일 | 변경 |
|---|---|
| `shared/plugin.ts` | **신규** — 매니페스트·권한·RPC·기여·상태 타입(전송-안전) |
| `shared/mcp.ts` 인접 | `McpGroup`에 `'plugin'` 추가 검토(또는 registry의 group 맵 확장) |
| `electron/plugins/*` | **신규** — manager/host/rpc/permissions/worker/handlers/config |
| `electron/agent/mcp.ts` | 변경 없음(이미 `registerMcpServer` 제공) — 매니저가 호출만 |
| `electron/agent/slash-registry.ts` | **신규** — 빌트인+플러그인 슬래시 합치기 |
| `electron/main.ts` | 부팅 시 `pluginManager.init()` 호출(외부 MCP `reload`와 같은 위치) |
| `electron/preload.ts` | `plugins:*` IPC 노출(목록/토글/권한/리로드) |
| `src/features/settings/PluginsSettings.tsx` | **신규** — `McpServersSettings.tsx` 형제 패널 |
| `src/features/settings/settingsCatalog.ts` 등 | 설정 카테고리에 "Plugins" 항목 추가 |
| `src/features/agent/AgentChat.tsx` | 슬래시 메뉴에 플러그인 커맨드 스냅샷 머지 |
| `README.md` / `AGENTS.md` | 플러그인 작성법·스캔 경로·권한 모델 문서화 |

---

## 7. 단계 계획 (Phased roadmap)

- **P0 — 본 설계 문서 (현재).** 격리 모델·권한·기여 포인트·머지 지점 확정.
- **P1 — 런타임 골격(헤드리스).** `shared/plugin.ts` + `electron/plugins/*` + worker + 합성
  McpServer 등록. 예제 플러그인 `hello-world`(도구 1개) + main-process 하니스
  (`harness:plugins`)로 spawn→activate→callTool→teardown E2E 검증.
- **P2 — 슬래시 커맨드 기여 + 설정 패널.** `slash-registry` + `PluginsSettings.tsx` + 권한 승인
  UX. 렌더러에서 끝까지 동작 확인.
- **P3 — 권한 가드 강화 + 문서.** `fs`/`net` 가드 + never-edit glob 연동 + 보안 리뷰(§8) +
  README/AGENTS 작성법.
- **v2(분리) — UI 패널 기여.** 샌드박스된 `webContents` + CSP로 플러그인이 탭/패널을 그리는 경로.

각 단계는 소유 패키지에서 `npm run typecheck` + 해당 하니스로 검증(AGENTS.md 규칙).

---

## 8. 보안 체크리스트 (플러그인 코드를 spawn하는 순간 필수)

- [ ] 플러그인 JS는 **main에서 절대 require/eval 안 함** — 오직 `utilityProcess` 안.
- [ ] worker는 `contextIsolation` 의미의 격리 + 빈 `env`/한정 `cwd`로 spawn.
- [ ] 모든 host↔worker 메시지는 **구조화-복제 가능한 JSON만**(함수/프로토타입 전달 금지).
- [ ] `fs:*`는 **워크스페이스 루트 안 + never-edit glob + realpath(symlink) 재검사**.
- [ ] `net`은 **manifest allowlist 도메인만**, 사설/loopback·리다이렉트 호스트 변경 차단, 본문 상한.
- [ ] 권한은 **기본 거부**; 선언+사용자 승인 없으면 RPC 거부. 권한 변경 시 재승인.
- [ ] 도구 기여는 **gated 기본** → 기존 승인/read-only 흐름을 반드시 통과.
- [ ] config 비면 **아무것도 spawn 안 함**(inert 출하), 크래시는 플러그인만 비활성.
- [ ] worker 로그/에러는 scrub([shared/scrub](../shared/scrub.ts)) 후 표시.
- [ ] `main`/`id`/경로 입력으로 폴더 이탈 불가(`..` 거부, 슬러그 강제).

---

## 9. Non-goals (v1)

- 렌더러 **UI 패널/탭 기여** — v2(샌드박스 뷰)로 분리.
- 플러그인 **마켓플레이스/원격 설치/자동 업데이트** — v1은 로컬 폴더 설치만.
- 임의 **네이티브 모듈/NPM 의존성 해석** — v1 플러그인은 단일 `index.js`(번들 책임은 작성자).
- 렌더러 `action` 슬래시 커맨드(패널 열기 등) — 권한 위임 위험으로 제외, `prompt`만 허용.
- 플러그인 간 통신/공유 상태 — 각 플러그인은 독립 worker, 격리 유지.
