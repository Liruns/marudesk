# marudesk — Background Agent (분리 실행 에이전트) 설계

> 상태: **제안 (2026-06-06)** · 범위: AI Chat에 부모 턴 수명을 넘어 분리 실행되는 백그라운드 에이전트 추가.
> 동반: [subagent 설계](./subagent-design.md) · [agentic-chat 설계](./agentic-chat-design.md) · [remote/mobile bridge 설계](./remote-mobile-bridge-design.md)
> 결정 입력: 실행 = **detached(턴 비차단)** · 툴 범위 = **read-only/non-gated만(v1)** · 결과 회수 = **registry + on-demand collect**.
> 관계: 본 문서는 [subagent 설계](./subagent-design.md)의 **직교(orthogonal) 확장**이다. subagent는
> "한 턴 안의 병렬"(부모 턴이 자식 종료를 기다림)을 다루고, 본 문서는 "**턴을 넘는 분리 실행**"을 다룬다.

## 0. 한 줄

부모 에이전트가 `spawn_background_agent` 도구로 **자식 루프를 await 없이 띄우고 즉시 task id만 받아**
턴을 끝낸다. 자식은 백그라운드에서 계속 돌고, 완료되면 **task registry에 결과를 남긴다**. 사용자(트레이
UI)와 부모(후속 턴의 `collect_background_agent`)가 결과를 회수한다. 분리 실행의 안전 비용은 자식 툴셋을
**read-only/non-gated로 고정**해 "사람 없는 승인" 문제를 원천 제거하는 것으로 치른다.

## 1. 왜 (현재 spawn과 무엇이 다른가)

현재 `spawn_subagent`는 부모 턴 루프 안에서 **블로킹 await**된다:

```ts
// electron/agent/loop.ts:516
const out = call.name === SPAWN_SUBAGENT
  ? await runSubagentTool(call.input, ctx)   // ← 자식이 끝날 때까지 부모 턴이 멈춤
  : await callMcpTool(call.name, call.input, ctx);
```

즉 자식이 도는 동안 부모 턴은 `tool_result`를 기다리며 점유된다. subagent 설계 §5가 말하는 "병렬"도
여전히 **한 턴 경계 안**(여러 spawn을 동시에 띄우되 그 턴이 전부 끝날 때까지 대기)이다.

백그라운드가 푸는 다른 문제:

- **긴 작업을 던져두고 대화 계속**: 10분짜리 리서치 fan-out을 걸어두고 사용자는 다른 일을 한다.
  현재 모델로는 그 10분 동안 채팅이 묶인다.
- **부모 컨텍스트 절약**: 자식 transcript가 부모 컨텍스트를 부풀리지 않는다. 부모는 짧은 최종 리포트만
  나중에 회수한다.
- **fire-and-forget 작업**: "이거 조사해서 메모에 적어둬" 류 — 부모 턴이 결과를 즉시 쓸 필요가 없다.

### 1.1 이미 깔린 자산 (재사용 전략)

- `runChildAgent(request, ctx)` (`electron/agent/subagent-runtime.ts`)는 **self-contained**다: 지역
  transcript, 지역 `streamText` 루프, `childToolDefs()`(read-only/non-gated 필터), `ctx.signal` 존중.
  `S` 싱글톤을 **전혀 건드리지 않는다**. → 백그라운드 실행에 그대로 재사용 가능. 바꿀 건 "await 하느냐"가
  아니라 "await **하지 않고** registry에 넣느냐"뿐.
- `loop-state.ts`의 `subscribeAgentEvents`/`emit`/`coalesced` fan-out 패턴 — 동일 패턴으로 background
  registry의 투영 채널을 만든다.
- `SubagentRunRequest`/`subagent-types.ts`의 상한들(`MAX_CHILD_STEPS`, `MAX_CHILD_RESULT_CHARS`)을
  그대로 상속.

## 2. 현재 구조와의 충돌점

1. **부모 턴 루프는 tool_use ↔ tool_result 짝을 강제한다.** 모든 `tool_use`는 같은 턴에서
   `tool_result`로 답해져야 `S.transcript`가 유효하게 유지된다(`loop.ts` 주석). 백그라운드 spawn은
   "결과를 나중에" 주므로, **spawn 도구 자체는 즉시 짧은 ack(`task id`)를 tool_result로 반환**하고,
   실제 자식 결과는 별도 회수 경로로 분리해야 한다. (= 도구는 동기, 작업은 비동기.)
2. **단일 스냅샷 투영.** 렌더러/브리지는 `agent:event`로 `AgentChatState` 하나만 본다. 백그라운드
   작업 목록은 이 스냅샷 밖의 **별도 registry 상태**이므로, 새 투영 채널(`agent:background-event` 또는
   `AgentChatState`에 `background` 필드 합류) 둘 중 하나가 필요. → 본 설계는 **`AgentChatState`에
   읽기 전용 `background` 요약 필드를 더하는** 쪽을 택한다(스냅샷 1개 원칙 유지, 브리지 자동 전파).
3. **수명/정리.** 백그라운드 작업은 부모 턴보다 오래 산다. 대화 `reset()`/`resumeSession()`
   (`loop-sessions.ts`) 시점에 살아있는 작업을 **취소(abort)** 해야 누수가 없다. 앱 종료 시 in-flight는
   소실(v1 허용) — 완료된 결과만 세션에 영속.
4. **승인 없는 실행.** 분리 실행은 정의상 "사람이 안 보고 있음". gated/write 도구가 승인 대기로 park되면
   작업이 무한정 멈춘다(= 백그라운드의 의미 상실). → §6에서 read-only 고정으로 회피.

## 3. 아키텍처 — Background Task Registry

```
renderer  src/features/agent/
   │  BackgroundTray.tsx (신규)  ← 활성/완료 작업 트레이(라벨, model, status, 결과 펼침, 취소)
   │  store.ts                   ← state.background[] 투영 (기존 단일 스냅샷 그대로)
main      electron/agent/
   ├─ loop.ts                    ← spawn_background_agent 인터셉트(즉시 ack 반환)
   ├─ background.ts (신규)       ← 작업 registry + 수명관리 + 트리 합성 + emit 연동
   ├─ subagent-runtime.ts        ← runChildAgent 재사용(변경 없음)
   ├─ tools/schemas.ts           ← spawn_background_agent / collect / cancel 스키마
   └─ tools/executors.ts         ← collect/cancel 실행기(registry 조회)
shared    agent.ts               ← BackgroundTask, BackgroundTaskSummary, AgentChatState.background
브리지    server/dispatch.ts      ← cancelBackground/collect 라우팅 (read 경로는 스냅샷에 자동 포함)
```

핵심: `background.ts`는 `loop-state.ts`의 `S`와 **독립된 모듈 레지스트리**를 들고, 작업 상태가 바뀔
때마다 `S.state.background`를 갱신하고 `emit()`을 호출한다. 자식 루프는 `runChildAgent` 그대로.

### 3.1 registry 형태

```ts
// electron/agent/background.ts
type BackgroundEntry = {
  task: BackgroundTask;            // shared 투영용 (아래 §4)
  controller: AbortController;     // 작업별 독립 abort
  promise: Promise<void>;          // 완료 추적 (회수는 task.result로)
  conversationId: string;          // 어느 대화 소속인지(reset 시 정리)
};

const registry = new Map<string, BackgroundEntry>();   // key = task.id ('bg-...')
```

`uid('bg')` (loop-state.ts의 `uid`)로 id 생성. 등록/완료/취소마다 `syncBackgroundIntoState()` →
`emit()`. coalesced emit이 틱당 1회로 묶어줘 비용 OK(원 설계 근거 유지).

## 4. 상태 모델 (shared/agent.ts 확장)

```ts
export type BackgroundStatus = 'running' | 'done' | 'error' | 'cancelled';

export type BackgroundTask = {
  id: string;                     // 'bg-...'
  label: string;                  // 패널/트레이 헤더용 짧은 이름
  task: string;                   // 위임된 작업(트림)
  provider: ProviderId;
  model: string;
  status: BackgroundStatus;
  startedAt: number;
  finishedAt: number | null;
  /** 완료 시 자식 최종 리포트(read-only). 미완료면 null. */
  result: string | null;
  /** 진행 표시용 짧은 trace tail (자식 transcript 전체가 아님). */
  trace: string[];
  usage: { inputTokens: number; outputTokens: number };
  /** 부모가 이미 collect 했는지 — 중복 회수/노이즈 방지. */
  collected: boolean;
};

// 기존 AgentChatState에 추가 (하위호환: 옵셔널, 기본 []):
//   background: BackgroundTask[];
```

스냅샷은 여전히 **틱당 1개**(`agent:event`). `background`는 그 페이로드의 한 필드일 뿐 → 렌더러와
브리지(M4 SSE/relay)가 **추가 채널 없이** 자동으로 받는다.

## 5. 모델-대면 도구

### 5.1 `spawn_background_agent` (gated, 즉시 ack)

```ts
// tools/schemas.ts
{
  name: 'spawn_background_agent',
  description:
    'Delegate a self-contained, READ-ONLY subtask to a detached background agent ' +
    '(optionally on a different provider/model). Returns IMMEDIATELY with a task id; ' +
    'the agent keeps running after this turn ends. Use for long research fan-out or ' +
    'fire-and-forget investigation you will collect later with collect_background_agent. ' +
    'The background agent has read-only tools only and cannot edit files or run gated tools.',
  inputSchema: {
    type: 'object',
    required: ['task'],
    properties: {
      task:     { type: 'string', description: 'Self-contained instructions for the background agent.' },
      provider: { type: 'string', description: 'Optional provider id; defaults to parent.' },
      model:    { type: 'string', description: 'Optional model id; defaults to parent.' },
      label:    { type: 'string', description: 'Short name for the tray entry.' },
    },
  },
}
```

- **인터셉트**(`loop.ts`, SPAWN_SUBAGENT 옆): `spawn_background_agent`는 `parseSubagentRequest`로 검증 후
  `startBackgroundAgent(request, ctx)`를 호출. 이 함수는 **await 하지 않고** registry에 등록하고
  `runChildAgent`를 백그라운드로 돌린 뒤 **즉시** `{ summary, text: 'Started background agent <id>...', isError:false }`
  를 반환. 부모 턴은 평소대로 진행/종료.
- 자식 ctx의 `signal`은 부모 턴 signal이 **아니라** registry entry의 `controller.signal`로 교체
  (부모 턴 종료가 자식을 죽이면 안 됨). 부모 turn signal은 무시.

### 5.2 `collect_background_agent` (non-gated, read-only 회수)

```ts
{
  name: 'collect_background_agent',
  description:
    'Fetch the status and (if finished) final report of background agents. Pass an id ' +
    'to collect one, or omit to list all background agents in this conversation.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'Optional task id; omit to list all.' } },
  },
}
```

- 실행기(`executors.ts`): registry 조회 → status/result/usage를 텍스트로 반환. `done`을 회수하면
  `collected=true` 마킹(트레이에서 "회수됨" 배지). 미완료면 status만.
- 이게 §2-1의 "결과를 나중에" 경로다. 부모는 같은 턴에서 `spawn`→(다른 작업)→`collect`로 **폴링**하거나,
  완료 알림(§7)을 받고 **다음 턴**에 collect.

### 5.3 `cancel_background_agent` (non-gated)

id로 `controller.abort()` → status `cancelled`. 사용자도 트레이 UI에서 취소(§10).

## 6. 안전 — read-only 고정으로 "사람 없는 승인" 회피 (핵심 결정)

분리 실행의 본질적 위험은 **승인 라우팅**이다. subagent 설계 §6은 자식 gated 도구를 "root 단일 큐로
park"해서 사람이 승인하게 했지만, 그건 사람이 보고 있는 in-turn 모델이라 가능했다. 백그라운드는 사람이
안 보므로 park는 곧 무한 정지다.

→ **v1 결정: 백그라운드 자식은 read-only + non-gated 도구만.** 이미 `runChildAgent`의 `childToolDefs()`가
정확히 그 필터다:

```ts
// subagent-runtime.ts
listMcpTools().filter((tool) =>
  tool.name !== ASK_USER && tool.name !== SPAWN_SUBAGENT &&
  tool.write !== true && tool.gated !== true);
```

여기에 백그라운드용으로 `spawn_background_agent`/`collect`/`cancel`도 자식 툴셋에서 제외(깊이 1 고정,
폭주 방지). 따라서:

- 새 fs/CDP 권한 표면 없음 — 백그라운드도 `readFileSafe`/read-only CDP만.
- gated/write 도구 자체가 자식에게 안 보임 → **park 상황이 발생하지 않음** → 승인 큐 불필요.
- 모든 페이지-유래 문자열 scrub 유지(자식도 동일 경로, 결과는 `scrubText` 통과 후 registry 저장).
- 브리지 가드 L-1(원격 self-approve 불가)와 무충돌 — 애초에 승인 지점이 없음.

> **비-목표(명시적 연기):** write 가능한 백그라운드 에이전트. 이건 subagent 설계 §6의 통합 승인 큐 +
> §7의 편집 직렬화(single-flight)가 먼저 구현돼야 안전하고, 그때도 "승인 대기 중 일시정지" 상태를
> 트레이에 surface 하는 별도 UX가 필요하다. v1 범위 밖.

## 7. 완료 알림 (선택, 권장 약식)

부모가 능동적으로 `collect` 하지 않아도 결과가 묻히지 않게:

- **UI**: registry → `state.background` → 트레이가 status 변화를 실시간 표시(§10). 사용자에게는 충분.
- **모델 알림(약식)**: 작업이 완료됐는데 부모가 다음 턴을 시작하면, 시작 시점에 **미회수(done,
  uncollected) 작업이 있으면** turn 프리앰블에 system-reminder 한 줄을 주입:
  *"Background agent `<id>` (`<label>`) finished. Call collect_background_agent to read it."*
  이건 자동 턴을 트리거하지 않는다(사용자 주도 유지) — 다음 사용자 메시지 처리 시 모델이 알 수 있게만 함.
- **자동 후속 턴은 비-목표(v1)**: 백그라운드 완료가 스스로 부모 턴을 깨우는 건 UX/과금 예측 가능성을
  해쳐 연기.

## 8. 동시성 / 자원 상한

- 대화당 **동시 활성 백그라운드 작업 상한**(예: 4). 초과 spawn은 거부 결과 반환(모델이 알 수 있게).
- 대화당 **백그라운드 누적 토큰 상한**. 초과 시 신규 spawn 거부 + 트레이 경고.
- 작업별 step 상한은 `MAX_CHILD_STEPS`(=6) 상속. 결과 길이 `MAX_CHILD_RESULT_CHARS`(=16k) 상속.
- read-only 고정이라 §subagent-7의 편집 레이스/브라우저 single-flight 큐는 **불필요**(write 없음).
  단 read-only CDP(스냅샷/콘솔 읽기)도 라이브 페이지를 공유하므로, 동시 다수 작업의 CDP read는
  **best-effort**(상태 변경 없으니 비결정성 허용). 필요 시 탭 단위 read 직렬화는 추후.

## 9. 수명 관리 (loop-sessions 연동)

- `reset()` / `resumeSession()` (`loop-sessions.ts`): 현재 `conversationId`에 속한 모든 registry
  entry를 `controller.abort()` + registry에서 제거. 새 대화로 백그라운드가 새지 않게.
- `conversationId`가 아직 없는(첫 턴 전) spawn은 불가 — spawn은 항상 활성 턴 안에서 일어나므로
  `S.conversationId` 보장.
- 앱 종료: in-flight 작업은 소실(v1 허용). 완료된 작업 결과는 §11로 세션에 영속.

## 10. UI (renderer)

- `BackgroundTray.tsx`(신규): AgentChat 하단/사이드의 접이식 트레이. 각 작업 = 라벨, provider/model 배지,
  status 점(running/done/error/cancelled), 경과 시간, 토큰, 완료 시 결과 펼침, 취소 버튼.
- `store.ts`: `state.background[]` 투영(기존 단일 스냅샷 구독 그대로, 새 구독 없음).
- 색/토큰은 `styles/tokens.css`/tailwind 토큰만(DESIGN.md 준수) — 새 색 도입 금지.
- 부모 transcript의 `spawn_background_agent` 툴 카드 → 클릭 시 해당 트레이 항목으로 점프.

## 11. 세션 영속 (sessions-store)

- 완료된 백그라운드 작업의 최종 리포트를 부모 `SessionRecord`에 **요약 링크**로 첨부
  (`backgroundResults: { id, label, provider, model, result }[]`). 전체 자식 transcript는 v1에서
  영속하지 않음(요약만) — 컨텍스트/저장 비용 절약.
- `resumeSession`으로 과거 대화를 열면 완료 결과는 보이되, **실행 중이던 작업은 복원하지 않음**
  (분리 프로세스라 재개 불가; cancelled로 표기).

## 12. 브리지 (M4 / relay) 영향

- `state.background`가 `AgentChatState`의 필드이므로 `RelayStateEvent`/`RemoteEvent.snapshot`에
  **자동 포함** — 새 이벤트 타입 불필요. 모바일 thin client는 트레이를 **렌더만**(로컬 로직 없음,
  패키지 경계 유지).
- `server/dispatch.ts`의 `AgentApi`에 `cancelBackground(id)` 추가(원격 취소). collect는 모델 도구라
  별도 API 불필요. 가드 L-1 무관(승인 지점 없음).

## 13. 증분 순서 (각 단계 typecheck 그린)

1. `shared/agent.ts`: `BackgroundTask`/`BackgroundStatus`/`AgentChatState.background`(옵셔널, 기본 [])
   추가. `emptyAgentChatState()`에 `background: []`. 이벤트 채널 가드 그린.
2. main: `background.ts` — registry + `startBackgroundAgent`(runChildAgent를 abort-controller로 감싸
   비-await 기동) + `collect`/`cancel`/`cancelForConversation` + `syncBackgroundIntoState`/emit 연동.
   자식 ctx.signal을 entry.controller.signal로 교체.
3. `tools/schemas.ts`: `spawn_background_agent`(gated) + `collect_background_agent`/
   `cancel_background_agent`(non-gated) 스키마. `mcp.ts` 등록(gated 마킹은 spawn만).
4. `loop.ts`: `spawn_background_agent` 인터셉트(즉시 ack). `collect`/`cancel`은 `executors.ts` 일반 경로.
   자식 툴셋 필터에 background 3종 제외 추가.
5. `loop-sessions.ts`: `reset`/`resumeSession`에서 `cancelForConversation(S.conversationId)` 호출.
   완료 결과를 SessionRecord에 첨부(§11).
6. 완료 알림(§7) turn 프리앰블 주입(미회수 done 있을 때만).
7. renderer: `store.ts` background 투영 → `BackgroundTray.tsx`.
8. 브리지: `dispatch.ts` `cancelBackground` + `shared/remote.ts`(background는 스냅샷에 이미 포함).
9. harness/e2e: fake-driver로 spawn→즉시 ack→폴링 collect, 동시 상한 초과 거부, reset 시 abort,
   read-only 필터(gated 도구 미노출) 검증. `npm run typecheck`/`build`/`harness:*`/`e2e` 그린 →
   커밋 → 리뷰.

## 14. 열린 질문 (구현 전 확정 필요)

- 동시 활성 상한 / 누적 토큰 상한 구체 수치 (subagent 설계와 공유? 별도?).
- 완료 알림(§7)을 v1에 넣을지, 트레이 UI만으로 충분한지.
- `collect` 미회수 결과의 컨텍스트 주입 방식: 전체 result vs. 요약 + "더 보려면 재호출".
- write 가능한 백그라운드(비-목표)를 언제, subagent 통합 승인 큐 위에 어떻게 올릴지.
- `spawn_subagent`(in-turn)와 `spawn_background_agent`를 별 도구로 둘지, 한 도구의 `detached: boolean`
  플래그로 통합할지 — 본 설계는 **별 도구**(설명/안전 제약이 달라 모델 혼동 적음)를 택했으나 재검토 여지.
