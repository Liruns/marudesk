# marudesk — Agentic AI Chat 설계 (assist → agent 실현)

> 상태: **구현 스펙** · 작성 2026-05-31 · 범위: 로드맵 §3/§9의 assist→agent 승격을 실제 코드로 + P0.5 scrub / P1 confidence / P2 revert를 도구·기능으로 흡수
> 동반: [로드맵](./roadmap.md) · [커스텀 DevTools 설계](./custom-devtools-design.md) · 참고: stagewise-io/stagewise (v2 패턴)

## 0. 한 줄

기존 **one-shot "propose patch"**(캡처 선택 → 프롬프트 → `llm:propose-patch` → ops → patch 적용)를 버리지 않고, 그 위에 **멀티턴·도구사용 에이전트 루프**를 올린다. 에이전트는 *도는 앱*을 CDP로 관찰하고, 워크스페이스 파일을 읽고, 편집을 적용하고, **reload 후 재관찰로 스스로 검증**한다. 사람은 운전석(승인·revert)에 남는다.

## 1. 왜 (근거)

- 로드맵 §3 결정: **assist-first → agent.** one-shot은 런타임-컨텍스트 가치를 싸게 증명했다(P0 커밋 `266e703`). 이제 §9의 "agent (나중)" 열을 실제로 만든다.
- 진짜 차별점은 **닫힌 루프**(patch → reload → 재관찰 → "에러 사라졌나" → 반복)이고, 이건 one-shot으로는 표현 불가 ([[positioning-wedge]]).
- stagewise v2 정찰 결론: 그들이 별도로 지어야 했던 것(WebContentsView+CDP, 에디터, 터미널, atomic patch-apply)을 marudesk는 **이미 소유**. 그래서 v1의 toolbar-injection + port-scan tRPC 브리지는 **불필요**(우리는 브라우저+에이전트가 한 프로세스). v2의 *에이전트 루프 모양 + 상태 모델*만 차용한다.

## 2. 차용 / 기각 (stagewise)

**차용:**
1. **수동 step-driven 루프** — `streamText(stopWhen: () => true)`처럼 한 스텝씩 직접 운전. 우리는 Anthropic SDK(이미 dep)로 동등하게: `messages.create` → tool_use 블록 실행 → tool_result 추가 → 재호출, 스텝 사이에서 abort/ask_user/스텝캡 제어.
2. **서버 소유 상태 → 렌더러는 투영(projection).** chat 상태(messages, status, pendingEdits, usage)를 main이 소유하고 `agent:event`로 렌더러에 패치 스트림. 렌더러 store는 순수 구독자.
3. **CDP/캡처/patch를 에이전트 도구로 승격**(§9). 사람-트리거 대신 모델-트리거.
4. **즉시-적용 + edit history → per-file accept/revert** (P2). 우리 atomic apply는 이미 `originalContent`를 계획에 담는다 — 그걸 세션 로그에 영속해 revert 생성.
5. **`ask_user` 1급 도구 + 상태 enum**(`idle|thinking|working|calling_tool|waiting_for_user|failed|completed`).
6. **파괴적 도구 승인 게이트** — 기존 CDP allowlist(파괴적 쌍둥이 차단)의 일반화. `eval_js`/네비게이션류는 명시적 게이트.

**기각(복사 안 함):** v1 toolbar Shadow-DOM 주입 · port 5746 스캔 · tRPC `agent-interface`/PushController 브리지 · iframe+postMessage 플러그인 UI · 멀티-프로바이더 난립 / 병렬 클라우드 에이전트 / git 워크플로 표면. (dogfood+포트폴리오엔 CDP 한 루프의 깊이 > 넓이; 파리티 freeze 유지.)

## 3. 아키텍처 (레이어)

```
renderer  src/features/agent/         ← 멀티턴 chat UI (store는 agent:event 투영)
   │  invoke: agent:send / agent:abort / agent:respond / agent:accept-edit / agent:revert-edit
   │  event:  agent:event (turn 진행 스트림)
main      electron/agent/
   ├─ loop.ts      ← 수동 step 루프(프로바이더 비종속) + 상태 소유 + 이벤트 방출
   ├─ tools.ts     ← 도구 정의(JSON schema) + 실행기(기존 인프라 래핑)
   ├─ history.ts   ← 적용 편집의 originalContent 영속 → accept/revert (P2)
   ├─ driver.ts    ← AgentDriver(프로바이더별 한 스텝 실행). anthropic 먼저.
   └─ handlers.ts  ← IPC 등록
shared    agent.ts (상태/메시지/도구 타입) · scrub.ts (순수 비밀 마스킹, P0.5)
재사용    workspace.ts(readFileSafe/rankFiles/index) · patch.ts(atomic apply) · browser/cdp.ts(sendCdp+allowlist) · browser/state.ts(에러 링버퍼)
```

핵심 규칙: **도구 실행기는 전부 기존 검증된 경로를 재사용**한다. 새 fs/CDP 권한 표면을 만들지 않는다 — `readFileSafe`(심링크/루트탈출 차단), `applyPatch`(3-phase atomic), `sendCdp`(allowlist) 그대로.

## 4. 도구 카탈로그 (§9 매핑)

| 도구 | 래핑 대상 | 비고 |
|---|---|---|
| `read_file(path)` | `readFileSafe` | 워크스페이스 한정 |
| `list_files(glob?)` | `ws.files` 필터 | 인덱스 기반, 저비용 |
| `grep(pattern, glob?)` | `readFileSafe` 스캔 | 결과 cap |
| `edit_file(path, old, new)` / `multi_edit` | `applyPatch` | 적용 후 history에 original 기록 |
| `get_console_errors(tabId)` | `state.getErrors` (P0 링버퍼) | **confidence 태그**(P1): stack→소스 결정론 = high |
| `query_dom(tabId, selector)` | `sendCdp` DOM/CSS | outerHTML+computed |
| `eval_js(tabId, expr)` | `sendCdp Runtime.evaluate` | **게이트**(승인); 결과 scrub |
| `read_network(tabId, filter)` | `sendCdp Network` + getResponseBody | **scrub 필수**(P0.5) |
| `reload_and_verify(tabId, signature?)` | `browser:reload` + 링버퍼 재감시 | **닫힌 루프**: 에러 사라짐/잔존 보고 |
| `ask_user(questions)` | — | 턴 일시정지, UI에 노출 |

도구 입력/출력은 `shared/agent.ts`에 타입 + 런타임 가드. 모델로 나가는 모든 페이지-유래 문자열(network body/headers, eval 결과, console 메시지)은 **scrub 통과**.

## 5. 루프 (의사코드)

```
turn(input): status=thinking
  msgs = [system, ...history, user(prompt + lean context refs)]
  for step in 0..MAX_STEPS:
    res = driver.step(msgs, TOOLS)        // 한 번의 model 호출 (스트리밍)
    emit assistant parts (text/tool_use)  // → agent:event
    if no tool_use: status=completed; break
    if abort: status=failed; break
    for each tool_use:
      if needs-approval and not approved: status=waiting_for_user; park; return
      result = execTool(name, input)       // 기존 인프라; scrub 적용
      emit tool_result                      // → agent:event
      msgs.push(tool_use, tool_result)
  emit final state
```

- **MAX_STEPS** 상한(예: 24) + per-turn 토큰 상한. 무한 루프/폭주 방지.
- **abort**: `agent:abort`가 플래그 set → 다음 스텝 경계에서 중단.
- **ask_user**: park된 턴은 `agent:respond`로 재개(park된 msgs 보존).
- **system prompt**: 편집 후 `reload_and_verify`로 *반드시 재관찰*하도록 지시(루프가 차별점).

## 6. P0.5 / P1 / P2 흡수

- **P0.5 (network + scrub):** `read_network` 도구 + `shared/scrub.ts`(순수, 단위 테스트 가능). Authorization/Cookie/Set-Cookie 헤더, Bearer/JWT/sk- 토큰, 이메일류를 마스킹. 네트워크는 "fix"가 아니라 **triage** 프레이밍(상태코드 원인 분류) — 도구 설명에 명시.
- **P1 (confidence):** `get_console_errors`/소스 해소 결과에 `confidence: 'high'|'medium'|'low'`. 결정론(console-stack same-origin → 파일) = high, fuzzy `rankFiles` = medium/low. 모델에 정직하게 전달.
- **P2 (accept/revert):** `history.ts`가 턴별 적용 편집의 `{path, before, after}`를 보관. `agent:revert-edit`(파일을 before로) / `agent:accept-edit`(영속 확정, 세션 로그에서 제거). 멀티파일 OK(기존 atomic apply가 보장).

## 7. IPC 추가 (shared/ipc.ts)

invoke:
- `agent:send` `{args:[{provider,model,prompt,captures,tabId?}]; result: {turnId}}`
- `agent:abort` `{args:[{turnId}]; result: boolean}`
- `agent:respond` `{args:[{turnId, answers}]; result: boolean}` (ask_user 응답)
- `agent:accept-edit` `{args:[{editId}]; result: boolean}` / `agent:revert-edit` 동형
- `agent:approve-tool` `{args:[{turnId, callId, approved}]; result: boolean}` (게이트)

event:
- `agent:event` — turn 진행(append message / update part / status / usage / pending-edit). coalesce는 cdp.ts 패턴 재사용(틱당 1 flush).

`IpcMapIsComplete`/`EVENT_CHANNELS` 갱신 — 컴파일 가드 그린 유지.

## 8. UI (renderer)

- `src/features/agent/AgentChat.tsx` — ContextDrawer "Composer" 탭을 **Agent / Quick patch** 토글로. Agent가 기본.
- 스트리밍 메시지 리스트(어시스턴트 텍스트 + tool-call 카드[이름+요약+상태]), 하단 입력, 상태 배지(enum), abort 버튼.
- **diff 카드**: 편집 도구 결과를 인라인 diff(기존 `DiffBlock` 재사용) + per-file Accept/Revert.
- **ask-user**: 인라인 질문 카드 → `agent:respond`.
- store는 `agent:event` 구독 투영(서버가 진실). 선택된 캡처(기존 `useWebPageStore`)는 첫 user 메시지의 lean 컨텍스트로 첨부.

## 9. 안전 / 비-목표

- 새 fs/CDP 권한 없음(기존 가드 재사용). `eval_js`·네비게이션류는 승인 게이트.
- 도구 출력 scrub(P0.5) — 비밀이 모델로 새지 않게.
- 에이전트 두뇌 자체제작 안 함 — 프로바이더 모델 사용(Anthropic 먼저). OpenAI/Gemini/Ollama는 `AgentDriver` 추가로 뒤따름(P3).
- **FREEZE 유지**: Sources 디버거/emulation/profiler 등 사람용 파리티 추가 없음(로드맵 §8).
- 테스트: 실제 LLM 호출 없는 e2e(UI 마운트 + IPC 가드) + 주입 가능한 fake driver로 루프 결정론 검증.

## 10. 증분 순서 (각 단계 typecheck)

1. `shared/agent.ts` + `shared/scrub.ts` + `shared/ipc.ts` 확장(컴파일 가드 그린).
2. main: `tools.ts`(실행기) → `driver.ts`(anthropic step) → `loop.ts`(상태/이벤트) → `history.ts` → `handlers.ts` → main.ts 배선.
3. renderer: `store.ts`(이벤트 투영) → `AgentChat.tsx` → ContextDrawer 토글.
4. e2e: 마운트 + IPC 가드 + fake-driver 루프; `npm run build` + `npm run test:e2e` 그린.
5. 커밋 → 리뷰 → 수정 → 리팩토링/최적화.
