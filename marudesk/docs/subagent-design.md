# marudesk — Subagent (병렬 에이전트) 설계

> 상태: **제안 (2026-06-04)** · 범위: AI Chat에 multi-provider subagent spawn 추가.
> 동반: [agentic-chat 설계](./agentic-chat-design.md) · [context-mcp 설계](./context-mcp-design.md) · [remote/mobile bridge 설계](./remote-mobile-bridge-design.md)
> 결정 입력: 실행/표시 = **병렬 visible agent** · 툴 범위 = **부모와 동일** · 진행 = **설계 먼저**.

## 0. 한 줄

부모 에이전트가 `spawn_subagent` 도구로 **다른 provider/model의 자식 에이전트를 띄워** 하위 작업을
병렬로 맡기고, 각 자식의 transcript를 UI에 **실시간 visible**하게 보여준다. 자식은 부모와 **동일한 툴셋**을
쓰되, 승인·편집·런타임 같은 위험 표면은 **단일 사용자 큐로 수렴**시켜 안전을 유지한다.

## 1. 왜 (근거)

- 이미 깔린 자산: `buildModel(provider, model, auth)`가 9개 provider를 Vercel AI SDK `LanguageModel`로
  통일(`electron/agent/model.ts`), `DRIVERS` 레지스트리(`electron/providers/index.ts`),
  메타데이터 붙은 `BUILTIN_TOOLS`(`electron/agent/tools/registry.ts`). 빠진 건 "이 머신을 부분적으로 떼서
  격리 루프로 돌리는 진입점" 하나.
- 가치: 싼/빠른 모델로 검색 fan-out, 다른 provider에게 second-opinion, 긴 작업의 병렬 분할 —
  전부 multi-provider 위에서 바로 나온다.

### 1.1 기존 결정의 명시적 번복 (정직하게 기록)

`agentic-chat-design.md` §2는 **"멀티-프로바이더 난립 / 병렬 클라우드 에이전트"를 기각**했다("넓이보다
한 루프의 깊이", parity freeze 유지). 그 후:

- multi-provider는 이미 들어왔다(9 providers). 첫 번째 비-목표는 사실상 무효.
- 이 문서는 두 번째 비-목표(**병렬 에이전트**)를 의도적으로 번복한다. 근거: 위 §1의 자산이 갖춰졌고,
  병렬화의 본질적 위험(상태 다중화, 동시 편집, 승인 라우팅)을 §4–§6에서 정면으로 다룬다.
- 단, 원 문서의 **안전 불변식은 유지**한다: 새 fs/CDP 권한 표면 없음, 모든 페이지-유래 문자열 scrub,
  gated 도구는 사람 승인. 병렬화가 이 불변식을 우회하지 못하게 하는 것이 본 설계의 핵심 제약.

## 2. 현재 구조와의 충돌점 (왜 작지 않은가)

`electron/agent/loop.ts`는 **모듈 싱글톤**이다(89–120행): `state`, `transcript`, `controller`,
`approvalResolver`, `answersResolver`, `conversationId` 가 전부 모듈 레벨 `let`. 주석이 명시:
*"A single conversation at a time keeps the model vs. transcript bookkeeping trivial."*

렌더러는 `agent:event`로 **단일 `AgentChatState` 스냅샷 1개**를 투영한다(Karton식 "UI is a projection").
브리지(M4 SSE/REST + relay)도 같은 단일 스냅샷을 옮긴다(`shared/remote.ts`의
`RelayStateEvent = { k:'event'; state: AgentChatState }`).

→ "병렬 visible agent"는 이 **단일 상태 가정을 직접 건드린다**. 상태를 트리로 다중화하고, 투영·브리지·
세션 영속을 그에 맞춰 일반화해야 한다. 이게 이 설계가 "툴 하나 추가"보다 큰 이유다.

## 3. 아키텍처 — 에이전트 트리 + 단일 사용자 수렴

핵심 모델: **하나의 부모(root) + N개의 자식**으로 이루어진 얕은 트리(초기엔 깊이 1, 자식이 또
spawn 못 함). 각 노드는 자기 transcript와 status를 갖되, **사용자와의 상호작용(승인·질문)은 root로 수렴**.

```
renderer  src/features/agent/
   │  AgentChat.tsx        ← root transcript + 자식 패널(접힘/펼침) 투영
   │  store.ts             ← AgentTreeState 투영 (단일 스냅샷 유지)
   │  event: agent:event   ← (변경) AgentChatState → AgentTreeState 스냅샷
main      electron/agent/
   ├─ loop.ts              ← root 루프. 모듈 싱글톤 유지(아래 §3.1)
   ├─ subagent.ts (신규)   ← 격리된 자식 루프 + 자식 레지스트리 + 트리 상태 합성
   ├─ tools/executors.ts   ← spawn_subagent 실행기(자식 루프 기동)
   ├─ tools/schemas.ts     ← spawn_subagent JSON schema
   └─ approvals.ts (신규)  ← agentId 키 단일 승인/질문 큐 (root로 수렴)
shared    agent.ts         ← AgentNodeState, AgentTreeState, spawn 입출력 타입
브리지    server/dispatch.ts ← 자식에 대한 abort/approve 라우팅(agentId 추가)
```

### 3.1 싱글톤을 안 깨는 법 — `AgentRuntime` 추출, root는 그대로

`loop.ts`의 모듈 상태를 **`AgentRuntime` 객체로 묶되**(state/transcript/controller/approval·answer
resolver/conversationId/sessionAllowedTools를 필드로), 모듈 싱글톤은 *root용 단일 인스턴스*로 유지한다.
자식은 같은 `AgentRuntime` 클래스의 **추가 인스턴스**다. 이렇게 하면:

- root의 외부 계약(IPC/브리지 진입점)은 변화 없음 — 기존 핸들러는 root 인스턴스로 위임.
- 자식은 독립 `controller`(독립 abort), 독립 transcript, 독립 model을 가진다.
- 트리 상태 합성기(`subagent.ts`)가 root+자식 인스턴스를 모아 단일 `AgentTreeState` 스냅샷을 만든다.

> 비-침습 대안(폴백): 자식을 클래스화하지 않고 `subagent.ts` 안의 순수 `runChildLoop()`(지역 transcript +
> `streamText` 루프)로만 구현. 더 작지만 자식 도구의 일부(approval 필요 도구)를 지원하기 까다롭다.
> **권고는 `AgentRuntime` 추출** — 부모/자식이 같은 루프 코드를 공유해 분기가 안 생긴다.

## 4. 상태 모델 (shared/agent.ts 확장)

기존 `AgentChatState`를 **노드 단위**로 재명명·재사용하고, 트리 래퍼를 추가한다. 하위호환을 위해
`AgentChatState`는 root 노드의 별칭으로 남긴다.

```ts
export type AgentNodeId = string;            // 'root' | 'sub:<uuid>'

export type AgentNodeState = AgentChatState & {
  id: AgentNodeId;
  parentId: AgentNodeId | null;              // root = null
  /** 자식의 한 줄 임무(부모가 spawn 시 지정) — 패널 헤더용. */
  task: string | null;
  provider: ProviderId;
  model: string;
};

export type AgentTreeState = {
  root: AgentNodeState;
  children: AgentNodeState[];                 // 초기엔 깊이 1
  /** 사용자 입력을 기다리는 노드(승인/질문)의 통합 큐 — root로 수렴. */
  pending: PendingInteraction[];              // §6
  /** 트리 전체 누적 usage(노드별 usage는 각 노드에 그대로). */
  totalUsage: { inputTokens: number; outputTokens: number };
};
```

- `pendingApproval`/`pendingQuestions`는 **노드에 그대로 두되**, UI/브리지가 보는 통합 큐
  `AgentTreeState.pending`로도 끌어올린다(어느 노드가 묻는지 `agentId` 포함).
- 스냅샷은 여전히 **틱당 1개**(`agent:event`). 단지 페이로드가 트리. 턴이 bounded라 비용 OK(원 설계 근거 유지).

## 5. 모델-대면 도구 — `spawn_subagent`

```ts
// tools/schemas.ts
{
  name: 'spawn_subagent',
  description:
    'Delegate a self-contained subtask to a child agent (optionally on a different ' +
    'provider/model). The child runs with the same tools, in the same workspace, and ' +
    'returns a final report. Use for parallel research fan-out, second opinions, or ' +
    'splitting long work. Spawn multiple in one turn to run them in parallel.',
  inputSchema: {
    type: 'object',
    required: ['task'],
    properties: {
      task:     { type: 'string', description: 'Self-contained instructions for the child.' },
      provider: { type: 'string', description: 'Optional provider id; defaults to parent.' },
      model:    { type: 'string', description: 'Optional model id; defaults to parent.' },
      label:    { type: 'string', description: 'Short name for the child panel.' },
    },
  },
}
```

- **실행기**(`executors.ts`): `provider/model`을 `isProviderId`/`MODELS`로 검증 → 부모 값으로 폴백 →
  `spawnChild({ task, provider, model, label })` 호출. **즉시 반환하지 않는다**: 자식이 끝나면 그
  최종 리포트(text)를 이 도구의 `tool_result`로 돌려준다. 부모는 그 사이 다른 도구를 더 호출할 수 있다
  (한 턴에 여러 spawn → 병렬).
- **병렬성**: 한 어시스턴트 스텝이 `spawn_subagent`를 여러 개 tool_use로 내면, 부모 루프가 그것들을
  **동시에 기동**하고 각 결과를 들어오는 대로 `tool_result`로 채운다(기존 루프의 순차 실행을 spawn
  도구에 한해 동시 실행으로 완화 — §7 동시성 정책 준수).
- **깊이 제한**: 자식의 툴셋에서 `spawn_subagent` 제외(깊이 1 고정). 폭주·과금 방지. (추후 깊이 N은
  토큰/노드 상한과 함께 별도 결정.)

## 6. 승인·질문 라우팅 — 단일 사용자 큐 (안전 핵심)

자식이 부모와 **동일 툴셋**을 쓰므로 `eval_js`(gated)·`edit_file`(write)·PC 제어 도구를 호출할 수 있다.
원 설계의 불변식("gated는 사람 승인")과 브리지 가드 L-1("원격 피어는 self-approve 불가")을 자식에도 적용:

- 자식이 gated 도구나 `ask_user`에 도달하면 **자식 루프를 park**하고, `PendingInteraction`을
  `agentId`와 함께 트리의 통합 큐에 올린다. **자식은 절대 self-approve 못 한다** — 결정은 사용자.
- IPC/브리지의 `agent:approve-tool` / `agent:respond`에 **`agentId`를 추가**해 어느 노드의 park를
  푸는지 지정. `subscribeAgentEvents`는 그대로(트리 스냅샷 한 곳에서 방출).
- `sessionAllowedTools`("Allow always")는 **노드별로 분리**(자식의 always 허용이 다른 노드로 새지 않게).

```ts
export type PendingInteraction =
  | { kind: 'approval'; agentId: AgentNodeId; turnId: string; callId: string; name: string; detail: string }
  | { kind: 'question'; agentId: AgentNodeId; turnId: string; callId: string; questions: AgentQuestion[] };
```

UI는 큐를 위에서부터 처리(어느 패널이 묻는지 배지로 표시). 여러 자식이 동시에 물어도 사용자는 한
큐만 본다.

## 7. 동시성 위험과 정책 (부모-동일 툴셋의 대가)

병렬 + write/runtime 도구는 진짜 레이스를 만든다. 정책으로 막는다:

- **파일 편집 직렬화**: `edit_file`/`multi_edit`는 워크스페이스 단위 **단일 비행(single-flight) 큐**를
  통과. 기존 atomic `applyPatch`(3-phase)는 한 편집의 원자성만 보장하지 동시 편집 순서는 보장 못 하므로,
  큐로 순서를 직렬화한다. `read-tracker`(편집 전 read 강제)는 **노드별**로 유지하되, 큐 통과 시점에
  파일이 그 노드의 마지막 read 이후 바뀌었으면 **stale로 거부**하고 재-read 유도(lost-update 방지).
- **브라우저/DevTools 도구**: 라이브 페이지 1개를 여러 노드가 동시에 `eval_js`/`click`하면 비결정적.
  → 브라우저 그룹 도구도 **single-flight 큐**(탭 단위)로 직렬화. 게다가 gated라 승인 큐가 자연 직렬화.
- **abort 전파**: root abort → 모든 자식 `controller.abort()`. 자식 단독 abort는 그 노드만.
- **usage/과금**: 노드별 usage 합산 → `totalUsage`. spawn 폭주 방지로 트리 동시 활성 자식 수 상한
  (예: 4) + 트리 누적 토큰 상한. 초과 시 `spawn_subagent`가 거부 결과 반환(모델이 알 수 있게).

## 8. 브리지 (M4 / relay) 영향

`shared/remote.ts`의 `RelayStateEvent`/`RemoteEvent.snapshot`이 `AgentChatState` → `AgentTreeState`로
넓어진다. `server/dispatch.ts`의 `AgentApi`(startTurn/abortTurn/respond/approveTool/snapshot/reset)에
**`agentId` 파라미터**를 추가(없으면 root). 가드 L-1(원격 self-approve 차단)은 그대로, 단 자식 승인도
동일 규칙으로 커버. 모바일 thin client는 트리를 렌더만 — 로컬 로직 없음(패키지 경계 유지).

## 9. 세션 영속 (sessions-store)

- `SessionRecord`에 **lineage** 추가: `parentSessionId`, `nodeTask`, `provider`, `model`.
- 자식은 자기 transcript를 별 세션으로 영속(부모 세션에서 링크). `list_sessions`/`read_session`은
  계보를 노출(부모가 과거 자식 결과를 회수 가능).
- 한 화면의 트리는 종료 시 root 세션 + 연결된 자식 세션들로 저장.

## 10. UI (renderer)

- `AgentChat.tsx`: 기존 root transcript 위에 **자식 패널 영역**(각 자식 = 접을 수 있는 카드: 라벨,
  provider/model 배지, status, mini-transcript, 토큰). 부모 transcript의 `spawn_subagent` 툴 카드를
  클릭하면 해당 자식 패널로 점프.
- `store.ts`: `AgentTreeState` 투영(여전히 단일 스냅샷 구독, 트리만 펼쳐 렌더). 색은
  `styles/tokens.css`/tailwind 토큰만(DESIGN.md 준수) — 새 색 도입 금지.
- 승인/질문: 통합 큐를 상단 배너/카드로, 어느 자식이 묻는지 라벨 표기 → `agentId` 동반 응답.

## 11. 안전 / 비-목표

- 새 fs/CDP 권한 표면 없음 — 자식도 `readFileSafe`/`applyPatch`/`sendCdp`(allowlist) 그대로.
- 모든 페이지-유래 문자열 scrub 유지(자식도 동일 경로).
- gated 도구는 사람 승인, 자식 self-approve 절대 불가(§6).
- **비-목표**: 깊이 >1 재귀 spawn, 자식 간 직접 메시지, 클라우드 분산 실행, git 워크플로 표면.
  전부 동시 활성 상한·토큰 상한 뒤로 미룬다.

## 12. 증분 순서 (각 단계 typecheck 그린)

1. `shared/agent.ts`: `AgentNodeState`/`AgentTreeState`/`PendingInteraction`/spawn 입출력 추가.
   `AgentChatState`는 별칭 유지. `IpcMapIsComplete`/이벤트 채널 가드 그린.
2. main: `loop.ts`의 모듈 상태 → `AgentRuntime`로 추출(root는 단일 인스턴스, **외부 동작 불변**).
   여기서 회귀 없는지 `npm run harness:*` + e2e.
3. `subagent.ts`(자식 레지스트리 + 트리 합성) + `approvals.ts`(단일 큐) + single-flight 편집/브라우저 큐.
4. `tools/schemas.ts` + `executors.ts`에 `spawn_subagent` + 깊이/상한 가드.
5. IPC/브리지에 `agentId` 추가(`handlers.ts`, `dispatch.ts`, `server/router.ts`, `shared/remote.ts`).
6. renderer: `store.ts` 트리 투영 → `AgentChat.tsx` 자식 패널 + 통합 승인 큐.
7. e2e: fake-driver로 부모→자식 spawn, 병렬 2자식, 자식 gated 도구 승인 큐, abort 전파, stale-edit 거부.
   `npm run typecheck`/`build`/`e2e` 그린 → 커밋 → 리뷰.

## 13. 열린 질문 (구현 전 확정 필요)

- 동시 활성 자식 상한 / 트리 누적 토큰 상한의 구체 수치.
- 자식 패널의 verbosity 기본값(부모와 별도?).
- 자식 실패 시 부모 처리: tool_result에 에러 텍스트 반환(권고) vs. 부모 턴도 실패 표시.
- 깊이 1 고정을 영구로 둘지, 상한과 함께 N 허용할지.
