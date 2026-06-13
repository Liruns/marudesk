# Maru — AI Work OS 로드맵

> 상태: **살아있는 문서 · 검증-우선(validation-first)** · 작성 2026-06-13 · 범위: "AI 작업
> 운영체제" 방향으로의 피벗 — 캔버스를 **Task 그래프**로, 도구를 **형제 도크**로.
> 동반 문서:
> AI Work OS 설계 (v0.1) — **레포 외부 초안, 미체크인**
> (`C:/Users/duct1/Downloads/ai-work-os-design.md`; 컨셉·메타모델·검증).
> 아래 ./ 상대경로 링크들과 달리 이 문서는 레포 밖에 있어 다른 독자/에이전트가 직접 검증할
> 수 없다 — 합의되면 `docs/ai-work-os-design.md`로 옮겨 동기화할 것. ·
> [Maru identity & canvas design](./maru-identity-and-canvas-design.md) (현재 canvas-of-cards 청사진) ·
> [제품 로드맵 (런타임 에러 픽스 루프)](./roadmap.md) (이전 프레이밍 — 대부분 출시됨)

이 문서는 "무엇을 만들지"보다 **"왜 이 순서로 만들지"** 를 남긴다. 결정의 근거와
*기각한 것*을 함께 적는다. 가장 큰 결정은 빌드가 아니라 **검증을 먼저 한다는 것**이다.

---

## 0. 상태 & 이 문서의 위치

**오늘(2026-06-13)의 사실관계.** Maru는 이미 두 번의 큰 정체성 이동을 했다.

1. `roadmap.md` — **런타임 에러 픽스 루프**(콘솔 에러 → 증거팩 → 패치 → reload 검증)와
   **assist→agent 승격**. 대부분 출시됨(P0/Agent/P0.5/P1/P1.5/P2/P3). 헤드라인은
   *"AI가 네 도는 앱을 본다(CDP)"*.
2. `maru-identity-and-canvas-design.md` — **무한 캔버스** 정체성. 탭 스트립 + split-grid를
   **자유 배치 카드의 캔버스**로 교체. Phase 2A~2D 거의 완료(캔버스가 기본 셸,
   web 카드 합성, 미니맵, 노드 연결, 반응형 패널).

**그리고 이제 세 번째 — AI Work OS 비전(설계 v0.1).** 캔버스가 *도구 카드의 무한 캔버스*가
아니라 **작업 흐름 지도(Task 그래프)** 가 되고, 도구(브라우저·에디터·터미널)는 노드 안이
아니라 **형제 도크/드로어**에서 열린다.

> **구현 상태 (Phase 1, 2026-06).** 사용자 결정에 따라 로드맵의 *별도 서피스 + ToolDock 분리*
> 대신 **기존 캔버스 확장**으로 얇은 슬라이스를 구현했다(생성→렌더→편집→실행→통과/실패):
> - ✅ `shared/work-os.ts` — Task/Edge(방향·타입)/Resource/Criterion/WorkGraph + 타입가드 + **순수
>   스케줄러**(readyTasks·topologicalOrder·parallelLayers·hasCycle) + `parseWorkGraph`(방어 검증).
>   14개 유닛테스트.
> - ✅ 캔버스 위 **Task 노드**(`src/features/work-graph/`): `useWorkGraphStore`(Task.id 키, `maru.
>   workgraph.v1` 별도 persist — `maru.canvas.*` 불변), 드래그/상태순환/depends_on 연결(사이클 거부)/
>   삭제, 방향성 엣지, status·acceptance 통과/실패(토큰 색만). e2e: `canvas.spec.ts`.
> - ✅ **AI 분해기** `electron/agent/decompose.ts`(generateText + `parseWorkGraph` 게이트, IPC
>   `workos:decompose`, provider 미연결/오류 시 결정적 오프라인 샘플로 폴백). 라이브 AI는
>   provider/key 필요(CI 미검증) — 오프라인 폴백 경로만 e2e로 검증.
> - ✅ **실행(시뮬레이션)** — `runSimulate`가 스케줄러를 walk하며 ready 셋(병렬) → done을 의존성
>   순서로 진행해 순서/병렬성을 가시화.
> - ⏳ **남음:** 실제 노드별 에이전트 실행(`run-task.ts` — read-only는 `runChildAgent`, write는
>   headless 실행자; outputs/evidence/status 기록). provider/key 필요 + 무거운 루프 배선이라 다음
>   슬라이스. 그리고 §5의 "그 다음"(선택적 재실행·per-criterion 검증·멀티에이전트 스케줄러).

### 긴장(TENSION)을 이름 붙인다

> **오늘의 Maru 캔버스는 각 카드를 "도구 표면"으로 만든다. 비전은 정확히 그것을 반(反)패턴으로
> 거부한다.**

- `maru-identity-and-canvas-design.md`의 캔버스 = **canvas-of-TOOL-CARDS**. 카드 하나가
  곧 탭이고, 탭은 곧 도구다(`kind: 'web'|'editor'|'terminal'|'agent'|...`).
  `CanvasCard`가 `tabKinds[tab.kind].render(tab.id, tab)`로 **도구 표면을 카드 프레임 안에서
  렌더**한다([`src/features/canvas/CanvasCard.tsx`](../src/features/canvas/CanvasCard.tsx),
  [`src/features/tabs/registry.tsx`](../src/features/tabs/registry.tsx)).
- AI Work OS 비전(설계 §3/§4)의 캔버스 = **TASK GRAPH**. 노드 타입은 **Task 하나**뿐이고,
  노드는 *의미*(title/intent/status/acceptance)다. 도구는 노드가 아니라 Task에 매달린
  **Resource**를 클릭했을 때 **형제 컴포넌트 트리(도크)** 에서 열린다.

설계 §4가 못 박은 문장: **"도구를 캔버스 노드 *안에* 한 번이라도 넣으면 '무한 쓰레기장'으로
회귀한다."** 오늘의 `CanvasCard`가 바로 그 상태다. 그래서 이 로드맵의 중심 리팩터는 한 문장으로:

> **canvas card-as-tool  →  node-as-Task (캔버스) + tool-pane-in-the-dock (형제 도크).**

### 보존되는 것 — 런타임 히어로는 버리지 않는다

`roadmap.md`의 차별점(*"AI가 네 도는 앱을 CDP로 본다"*)은 **폐기되지 않는다.** 형태만 바뀐다:

- 항상-켜짐 콘솔 캡처 + CDP 증거 정규화([`shared/runtime-evidence.ts`](../shared/runtime-evidence.ts),
  [`shared/network-evidence.ts`](../shared/network-evidence.ts), `reload_and_verify`)
  → **Task.evidence**(궤적·결과)와 **acceptance 검증의 1차 신호**가 된다.
- `WebContentsView` + `browser:set-pane-bounds` 합성 파이프라인 → **browser ToolProvider**가
  된다(노드가 아니라 도크가 호스팅하는 라이브 뷰).

즉 런타임-aware는 *증거 레이어*와 *browser 도구*로 흡수된다. 히어로는 살아 있고, 캔버스의
*의미*만 도구에서 작업으로 옮겨간다.

**단, 보존의 정당성은 엔지니어링 근거이지 §6.1 가정의 증거가 아니다.** 런타임 히어로의
출시·dogfood는 *증거 레이어*(CDP 정규화·reload 검증)가 **작동함**을 검증하지, 사람이 분해된
Task 그래프의 *과정을 감독하고 싶어 한다*는 §6.1 가정을 검증하지 않는다 — 그건 여전히 Phase 0의
표적이다. 더구나 히어로가 검증한 루프(콘솔 에러 → 패치 → reload 재검증)는 그 자체로 좁고
점점 자동화되는 종류의 일이라, 설계 §6.2가 경고하는 추세선의 *틀린 쪽*에 가깝다. 히어로의
재사용은 정직하게 "기판이 작동한다"는 증거이고, 감독 베팅의 차용 신용으로 쓰지 않는다.

### 이 문서의 자세 — 검증-우선

설계 §6이 정직하게 적었듯, 차별화의 핵심은 **미검증 베팅**이다. 그래서 이 로드맵은
*Phase 0이 빌드가 아니라 검증*이다(§4, §5). 코드를 더 짜기 전에 답할 단 하나의 질문:
**진통제(painkiller)인가, 비타민(vitamin)인가?**

---

## 1. 메타모델 못박기

> 설계 §3을 이 코드베이스에 맞춘다. "노드 하나가 정확히 무엇인가?"가 UI보다 먼저다.

**노드 타입은 하나뿐 — Task.** Goal/Decision/Resource/Agent는 노드가 아니라 Task의
속성·서브타입·역할로 접힌다.

- **Goal** = 루트 Task의 `intent`(별도 노드 아님).
- **Agent** = `executor`(누가 수행하나).
- **Decision** = `kind: 'decision'`(사람 감독 게이트).
- **Resource** = Task에 매달리는 입출력 아티팩트(노드 아님). 클릭하면 도구가 열린다.

### 위치 (proposed)

신규 순수 모듈 **`shared/work-os.ts`** (import 0, main·renderer·test 공유 — `marudesk/shared/*`
규약대로). 기존 `shared/agent.ts`의 `AgentPlan`(평면 체크리스트)과 **별개**로 둔다. 이름이
`task-graph`보다 `work-os`인 이유: 동반 산출물(도크·executor·검증)도 같은 모듈군에 모은다.

union마다 **타입가드를 함께 배송**한다 — `shared/*` 전역 규약(`isSpecStatus` in
[`specs.ts`](../shared/specs.ts) L21, `isProviderId` in [`providers.ts`](../shared/providers.ts) L128,
`isTabKind` in [`browser.ts`](../shared/browser.ts))에 맞춘다.

```ts
// shared/work-os.ts — strict TS, no any. CDP/AgentPlan과 독립.

export type TaskId = string;
export type ResourceId = string;
export type EdgeId = string;

export type TaskKind = 'work' | 'decision';
export type TaskStatus =
  | 'planned'
  | 'running'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'needs_review';

export const TASK_STATUSES: readonly TaskStatus[] = [
  'planned', 'running', 'blocked', 'done', 'failed', 'needs_review',
];

/** Resource.uri 스킴이 도구 디스패치의 1차 키 (설계 부록). */
export type ResourceKind = 'code' | 'doc' | 'url' | 'term' | 'db';
export const RESOURCE_KINDS: readonly ResourceKind[] = [
  'code', 'doc', 'url', 'term', 'db',
];

export type EdgeType = 'depends_on' | 'data';
export const EDGE_TYPES: readonly EdgeType[] = ['depends_on', 'data'];

export type Resource = {
  id: ResourceId;
  kind: ResourceKind;
  /** 모든 정보를 스킴에 담는다: file:///…#L42 · https://… · term://<id> · db://… */
  uri: string;
  /** 선택 — 보통 스킴으로 추론, 명시는 override. tabKinds 키가 아니라 ToolProvider id. */
  opensWith?: string;
  /** 사람이 읽는 라벨(노드 칩에 표시). */
  label?: string;
};

/** 상류 Task의 출력 또는 자유 Resource를 가리키는 입력 참조. */
export type Ref =
  | { kind: 'task-output'; taskId: TaskId; resourceId: ResourceId }
  | { kind: 'resource'; resourceId: ResourceId };

/** 실행자: Agent는 agents-store 역할(explore/planner/...)/모델 tier로 resolve. */
export type Executor =
  | { type: 'agent'; ref: string }   // ref = role id 또는 model tier (subagent-resolve)
  | { type: 'human'; ref?: string }; // 사람이 하는 Task (오늘 표현 없음 — 신규)

/** acceptance 한 criterion + 그 검증 결과. 1급 데이터 (설계 §3.2). */
export type Criterion = {
  id: string;
  text: string;                       // "콘솔 에러 0" · "npm run typecheck 통과"
  /** 시스템이 검증해 채움(human toggle 아님). */
  verdict: 'unknown' | 'pass' | 'fail';
  checkedAt?: number;
  /** 이 verdict를 낳은 증거 step(아래 TrajectoryStep.id) 또는 capture id로의 포인터. */
  evidenceRef?: string;
};

/** 궤적 한 step — id-주소화 가능해 Criterion.evidenceRef가 가리킬 수 있다. */
export type TrajectoryStep = {
  id: string;
  kind: 'message' | 'tool-call' | 'tool-result' | 'verdict';
  /** 사람이 읽는 요약(transcript에서 유래). 원본 parts는 sessions-store가 보유. */
  summary: string;
  at: number;
};

export type TaskEvidence = {
  /** 이 Task를 실행한 턴(들)의 궤적 — id-주소화된 step 목록(evidenceRef 백킹). */
  trajectory: TrajectoryStep[];
  /** 사람이 읽는 결과 요약 + per-criterion verdict의 집계. */
  result: string;
};

export type Task = {
  id: TaskId;
  title: string;                      // Task 중심: "주문 변경 영향도 분석"
  intent: string;                     // 왜 존재하나 = Goal 컨텍스트
  kind: TaskKind;
  status: TaskStatus;
  executor: Executor;
  inputs: Ref[];
  outputs: Resource[];
  acceptance: Criterion[];            // SpecTask가 아니라 검증 verdict를 든 criterion
  evidence?: TaskEvidence;
};

export type Edge = {
  id: EdgeId;
  from: TaskId;
  to: TaskId;
  type: EdgeType;                     // 방향 있음 — 오늘 undirected와 결정적 차이
};

/** 한 Goal에서 생성된 그래프 전체. 캔버스의 도메인 모델. */
export type WorkGraph = {
  id: string;
  goal: string;                       // 루트 intent
  tasks: Task[];
  edges: Edge[];
  createdAt: number;
  updatedAt: number;
};

// --- 타입가드(specs.ts/providers.ts 규약) — generateObject 출력 검증과 store 경계에 사용 ---

export function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && (TASK_STATUSES as readonly string[]).includes(v);
}
export function isResourceKind(v: unknown): v is ResourceKind {
  return typeof v === 'string' && (RESOURCE_KINDS as readonly string[]).includes(v);
}
export function isEdgeType(v: unknown): v is EdgeType {
  return typeof v === 'string' && (EDGE_TYPES as readonly string[]).includes(v);
}
```

**오늘 스키마와의 차이(못박는 포인트):**

- `Task`는 **탭이 아니다.** 오늘 노드는 `tabId`이고 그 탭은 *도구*를 기술한다. Task는 *작업*을
  기술한다 — title/intent/status/executor/acceptance 어느 것도 오늘 존재하지 않는다.
- `Edge.type`(`depends_on`|`data`) + **방향**은 신규다. 오늘
  [`canvas/store.ts`](../src/features/canvas/store.ts)의 `Edge = {id, from, to}`는 **무타입·무방향**
  이고 `addEdge`가 `from~to`와 `to~from`을 둘 다 dedup한다(line 234–241).
- `Criterion.verdict`는 **시스템이 검증해 채운다.** 오늘 `SpecTask.done`은 *사람 체크박스*
  ([`shared/specs.ts`](../shared/specs.ts) line 10–14)다 — 증거 백킹이 없다.
- `Resource`는 신규 타입이다. 오늘 그 정보는 `TabState.{url, filePath, terminalProfile}`로
  도구별로 흩어져 있다([`shared/browser.ts`](../shared/browser.ts)).
- `TaskEvidence.trajectory`는 **평면 문자열이 아니라 id-주소화된 step 목록**이다 — §4 검증
  스토리가 `Criterion.evidenceRef`로 *특정 step*을 가리켜야 하므로, stringly-typed면 그 구조를
  잃는다. 원본 parts는 `sessions-store`가 보유하고 step은 그 요약 투영이다(§2 매핑).

---

## 2. 코드베이스 매핑 (reuse / refactor / new)

> 4명의 에이전트가 코드를 정독해 낸 그라운딩 위에서만 적는다. 과대주장 금지. **"reuse"는
> "오늘 그대로 호출 가능"을 뜻한다 — extract-후-reuse나 신규 배선이 필요하면 refactor/new로
> 분류한다.**

### 가장 큰 리팩터 (놓치면 안 됨)

> **`CanvasCard` 도구-표면 → Task-노드(캔버스) + 도구-패인(도크) 분리,
> 그리고 도구 표면을 캔버스 placement 스토어에서 떼어내기.**

오늘 캔버스 노드와 도구 표면은 **같은 객체**다: 노드 = `tabId`, 탭 = 도구
(`kind=web/editor/terminal/agent`), `CanvasCard`가 그 도구를 프레임 안에 렌더한다. 피벗은
세 가지를 동시에 요구한다.

1. **node↔tab 정체성 끊기** — Task 모델을 도입하고 placement가 `Task.id`로 키된다(오늘은
   `tabId`로 키되고 localStorage `maru.canvas.v1`에 그대로 직렬화된다).
2. **새 TaskNode 본문은 도구를 렌더하지 않는다** — `tabKinds[kind].render(...)`나 web 측정 div
   없이, Task 요약 뷰(status chip · executor · acceptance 빨강/초록 · Resource 칩)만 그린다.
   기존 `CanvasCard`는 §7-1 결정 전까지 *그대로 둔다*(canvas-of-cards 불변).
3. **공간 인터랙션 레이어 추출** — `CanvasStage`의 wheel/pan/snap/connect/fit/minimap 핸들러는
   현재 컴포넌트 안에 인라인이고 `useTabsStore`/`useWorkspaceDeckStore`/`tabId` placement에
   하드와이어돼 있다. 재사용하려면 *먼저* 탭-무관 opaque-node-id 키 훅으로 빼내야 한다(아래 박스).
4. **도구 표면 레이어 통째 재배치** — `WebContentsView` measure→`set-pane-bounds` 합성
   파이프라인을 캔버스 밖, 형제 도크로 옮긴다(공유 open-panes 스토어로만 통신).

> **선행 추출(pre-Phase-1 또는 Phase-1 첫 작업):** "캔버스 공간 인터랙션 레이어
> (wheel/pan/snap/connect/fit/minimap glue)를 `CanvasStage`에서 빼내 *탭-무관·opaque-node-id 키*
> 훅으로 만들고, `CanvasStage`와 `WorkGraphStage`가 둘 다 그 훅을 소비한다." viewport 수학
> (`zoomAt/panBy/fitToContent/clamp`)은 `useCanvasStore`에 있어 *진짜 reuse*지만, 컴포넌트
> 레벨 핸들러는 **extract-then-reuse**이지 drop-in이 아니다.

### 매핑 표

| 설계 개념 | 오늘의 산출물 | 처분 | 핵심 파일 |
|---|---|---|---|
| **Node = Task** (유일 노드 타입) | `CardRect` placement(`tabId` 키) + `TabState`. **Task 타입 없음** | **new** | [`canvas/store.ts`](../src/features/canvas/store.ts), [`tabs/store.ts`](../src/features/tabs/store.ts), [`shared/browser.ts`](../shared/browser.ts) → 신규 `shared/work-os.ts` |
| **Edge {from,to,type}** (방향·타입) | `Edge {id,from,to}` 무타입·무방향, 양방향 dedup | **refactor** | [`canvas/store.ts`](../src/features/canvas/store.ts) L234–241, [`canvas/CanvasEdges.tsx`](../src/features/canvas/CanvasEdges.tsx) |
| **Task 노드(=의미) 렌더** | `CanvasCard`(도구 표면을 프레임 안에 렌더 — 反패턴) | **new (신규 TaskNode; 기존 CanvasCard 불변)** | [`canvas/CanvasCard.tsx`](../src/features/canvas/CanvasCard.tsx) (프레임 크롬 참고) |
| **공간 엔진(viewport·wheel·pan·snap·connect·fit·minimap)** | viewport 수학은 `useCanvasStore`에 reuse-가능; 핸들러는 `CanvasStage`에 인라인·탭 결합 | **refactor (extract-then-reuse)** | [`canvas/CanvasStage.tsx`](../src/features/canvas/CanvasStage.tsx), [`canvas/store.ts`](../src/features/canvas/store.ts) |
| **ToolProvider 레지스트리** (canOpen/open, resolveTool by uri-scheme, dedupe+LRU) | `tabKinds: Record<TabKind,{title,icon,render}>` (enum 키, render는 카드 본문 반환) | **refactor** | [`tabs/registry.tsx`](../src/features/tabs/registry.tsx) |
| **Resource {kind,uri}** (Task에 매달림) | `TabState.{url,filePath,terminalProfile}` 흩어진 필드 | **new** | [`shared/browser.ts`](../shared/browser.ts), [`shared/workspace.ts`](../shared/workspace.ts) |
| **하드 경계: 캔버스/도크 = 형제, 공유 store만** | `CanvasStage`→`CanvasCard`→도구 표면 (부모→자식, 경계 역전됨) | **new(ToolDock/dock store) + refactor(bounds source 이전)** | 신규 `dock/ToolDock.tsx`·`dock/store.ts` + [`tabs/browserPaneBounds.ts`](../src/features/tabs/browserPaneBounds.ts) |
| **Task 실행 — 읽기전용/분석 노드** | `runChildAgent`(read-only toolset: `tool.write !== true` 필터, subagent-runtime.ts L216) | **reuse** | [`agent/subagent-runtime.ts`](../electron/agent/subagent-runtime.ts) |
| **Task 실행 — write-capable 노드(코드/출력 생산)** | `runLoop`은 **export 안 됨**(loop.ts L234 내부 함수); 공개 진입은 `startTurn`(thread/approval/session 머신 동반) | **new (headless 실행자 신규; 또는 runLoop export 리팩터)** | [`agent/loop.ts`](../electron/agent/loop.ts) (L234 runLoop, L951 startTurn), [`agent/loop-state.ts`](../electron/agent/loop-state.ts) |
| **Task.executor = {agent, ref}** | `BUILTIN_AGENTS` 역할 + subagent-resolve(tier→model) + runChildAgent | **refactor** | [`agent/agents-store.ts`](../electron/agent/agents-store.ts), [`agent/subagent-resolve.ts`](../electron/agent/subagent-resolve.ts), [`agent/subagent-runtime.ts`](../electron/agent/subagent-runtime.ts) |
| **goal → Task 그래프 JSON 생성** | **없음.** `update_plan`/`AgentPlan`이 최근접이나 *평면 체크리스트*; `generateObject`도 **레포 전무**(streamText/generateText만 사용) | **new (Phase 1 심장)** | [`agent/plan.ts`](../electron/agent/plan.ts), [`shared/agent.ts`](../shared/agent.ts) |
| **Task.evidence.trajectory** | `ThreadContainer.transcript` + `AgentMessage.parts` + child `traces` | **refactor (구조→TrajectoryStep 투영)** | [`shared/agent.ts`](../shared/agent.ts), [`agent/sessions-store.ts`](../electron/agent/sessions-store.ts) |
| **Task.acceptance[] (통과 기준)** | `Spec.tasks: SpecTask[]{id,text,done}` 사람 체크박스 | **refactor** | [`shared/specs.ts`](../shared/specs.ts), [`electron/specs/store.ts`](../electron/specs/store.ts), [`context/SpecsPanel.tsx`](../src/features/context/SpecsPanel.tsx) |
| **Task.evidence.result (verdict)** | `reload_and_verify`(GONE/STILL PRESENT) + `runVerifyNote`(PASS/FAIL) — *문자열, 비영속* | **refactor** | [`agent/tools/runtime-tools.ts`](../electron/agent/tools/runtime-tools.ts), [`agent/loop-commands.ts`](../electron/agent/loop-commands.ts) |
| **Task.evidence 휴대용 export** | `formatEvidencePack(capture)` (순수·scrub됨) | **reuse** | [`shared/evidence-pack.ts`](../shared/evidence-pack.ts), [`shared/scrub.ts`](../shared/scrub.ts) |
| **code ToolProvider (file:///…#L42 → Monaco)** | `useEditorStore`(docKey=uri 키) + `RevealRequest`(#L42) | **refactor (탭 생명주기 탈착)** | [`editor/store.ts`](../src/features/editor/store.ts), [`editor/EditorView.tsx`](../src/features/editor/EditorView.tsx) |
| **browser ToolProvider (url → WebContentsView)** | `'web'` TabRecord + `set-pane-bounds`(tabId 키) | **refactor (둘째 최대)** | [`electron/browser/layout.ts`](../electron/browser/layout.ts), [`electron/browser/tabs.ts`](../electron/browser/tabs.ts), [`tabs/browserPaneBounds.ts`](../src/features/tabs/browserPaneBounds.ts) |
| **term ToolProvider (term:// → xterm+PTY)** | session 레지스트리(tabId 키) | **refactor** | [`terminal/session.ts`](../src/features/terminal/session.ts), [`tabs/TerminalSurface.tsx`](../src/features/tabs/TerminalSurface.tsx) |
| **멀티에이전트 오케스트레이션** | foreground subagent + background agent + run-tree projection | **reuse (후기 phase)** | [`agent/subagent-runtime.ts`](../electron/agent/subagent-runtime.ts), [`agent/orchestration-state.ts`](../electron/agent/orchestration-state.ts) |

**그라운딩 노트(낙관 보정):**

- 에디터 도구는 **저위험이지만 drop-in은 아니다.** `useEditorStore.files`는 이미 `docKey`(uri-like)로
  키되고 `RevealRequest`가 이미 `#L42` 라인 점프를 구현한다(이 둘은 진짜 reuse). 그러나
  `openFile`은 `browser:tabs-new` IPC로 **탭을 연다**(editor/store.ts L82–98)고, `pruneClosed`는
  `subscribeTabsByKind('editor', …)`(L334)로 **탭 스토어에 구동**된다. 즉 open·prune 양쪽이
  `useTabsStore`에 묶여 있어 — "트리거 한 줄 repoint"가 아니라 **탭 생명주기에서 탈착**해
  도크 pane set이 구동하게 해야 한다.
- main의 `set-pane-bounds` 경계는 per-pane으로 **`{tabId, rect}`만** 본다(layout.ts L151).
  `scale`(캔버스 줌)은 `panes`의 형제인 *top-level 옵션*이고 **캔버스만** 보낸다(L157–159;
  classic grid는 생략). 다중-source 헬퍼 `browserPaneBounds.ts`는 `{panes}`만 보내고 scale은
  아예 뺀다(L16, 21). 그래서 browser 뷰를 도크로 옮기는 renderer-side 작업은 bounds *source*를
  도크 pane rect로 옮기는 것이고(`setBrowserPaneBoundsSource`가 이미 다중 source 지원), **도크
  source는 scale을 빼거나 도크-평면 기준으로 재유도**한다(§3 함정의 paneScale 노트와 일치).

---

## 3. 절대 경계

> 설계 §4: **노드 = 의미, 창 = 도구.** 이 한 가지가 컨셉을 코드로 강제한다.

### 규칙

1. **캔버스 = 지도(map) only.** `WorkGraphStage`/`TaskNode`(신규)는 Task 노드 + 타입 있는 엣지만
   렌더한다. 도구 표면 없음, `measureWeb` 없음. (이는 **신규 컴포넌트를 그렇게 짓는다**는
   뜻이지, *살아있는* `CanvasCard`를 도려낸다는 뜻이 아니다 — §6/§7-1대로 canvas-of-cards는
   불변.)
2. **도크 = 도구 only.** 신규 `ToolDock` 컴포넌트가 pane을 렌더하고 `WebContentsView`
   measure→`set-pane-bounds` 파이프라인을 소유한다.
3. **둘은 형제다 (부모-자식 아님).** Shell 아래에 `WorkGraphStage`와 `ToolDock`이 **나란히** 산다.
4. **공유 store만이 채널이다.** `openResource(r)` / `focusPane(uri)` / `closePane(uri)`를 가진
   open-panes 스토어가 유일한 통신 경로.

### 이 코드베이스에서 어떻게 강제하나

- **import 부재로 강제(컴포넌트 트리).** 오늘 도구 표면은 `CanvasCard`의 *자식*이다(경계 역전).
  경계는 신규 `work-graph/`(WorkGraphStage·TaskNode)를 **`tabKinds` import 없이** 짓는 것으로
  강제한다 — 기존 `CanvasCard`에서 `tabKinds.render`를 삭제하는 게 아니다(그건 출시된
  canvas-of-cards를 깨뜨려 §6/§7-1과 모순). 도구를 다시 노드에 넣으려면 `work-graph/`에
  `tabKinds` import를 끌어와야 하므로 PR과 lint에서 즉시 드러난다.
- **store 분리로 강제.** Task 그래프 스토어(`useWorkGraphStore`)와 도크 스토어(`useDockStore`)를
  분리한다. 캔버스는 도크 스토어를 *쓰기*만 하고(클릭 시 `openResource`), 도구 인스턴스를
  *읽지* 않는다.
- **bounds source로 강제.** `setBrowserPaneBoundsSource('dock:<ws>', panes)`로 source를 도크로
  넘긴다. `'canvas:<ws>'` source가 사라지는 것이 곧 "캔버스가 web 뷰를 더는 호스팅하지 않는다"의
  기계적 증거.
- **lint 규약.** `src/features/work-graph/**`가 `tabKinds`나 `src/features/{editor,terminal}`
  표면을 import하면 거부한다(`no-restricted-imports`를 신규 `work-graph/` 디렉토리에 스코프).

### 함정 (그라운딩 리스크)

- web-card-under-transform 측정은 캔버스 평면(`scale`) 기준으로 튜닝돼 있다. `applyPaneBounds`
  (layout.ts L47–68)가 `getPaneScale()`를 읽어 `setZoomFactor(scale)`를 호출하고,
  `clearBrowserPaneBounds`가 탭별 zoom을 복원한다. 도크 pane은 캔버스 transform 아래가
  **아니므로** 도크 source는 **scale을 보내지 않거나(=1)** 도크-평면 기준으로 재유도해야 하고,
  도크를 떠날 때 classic/canvas page zoom 복원을 **밟지 말아야** 한다(`getPaneScale`/
  `clearBrowserPaneBounds`와 조율; 이중 스케일 회피).
- `setBrowserPaneBoundsSource`는 모든 source를 **단일 `panes` 배열로 평탄화**해 한 번의
  `browser:set-pane-bounds`로 invoke한다. 워크그래프와 캔버스 surface가 **surface flag로 상호
  배타**라서 안전하게 합성된다 — 만약 둘이 동시 마운트되면 둘 다 `tabId` 키라 main에 동시
  공급되므로, 그 경우엔 단일 평탄 invoke에 **source-우선순위 규칙**이 필요하다.
- 항상-켜짐 콘솔 캡처/에러 버퍼는 web TabRecord에 키돼 있다. 도크가 뷰를 detach/reattach하면
  에러 배지 생명주기(네비에서 clear, did-start-loading에서 재enable)를 재감사해야 런타임 증거
  웨지가 계속 작동한다.

---

## 4. 리스크 & 검증해야 할 가정

> 설계 §6을 정직하게 포팅한다. 아키텍처는 건전하나 *차별화의 핵심*은 미검증 베팅이다.
> 이건 사형 선고가 아니라 **실제 리스크 프로파일**이다.

| 가정 | 상태 | 이 로드맵이 어떻게 디리스크하나 |
|---|---|---|
| **Load-bearing: "사람은 과정을 보고 싶어 한다"** (설계 §6.1) | **미검증.** 컴퓨팅 史는 압도적으로 과정을 *숨기는* 쪽(컴파일러·ORM). 구조를 드러낸 비주얼 도구(Light Table·Enso·Blueprint)는 다수 피벗/중단. *조건부로만* 참 — 고위험·장시간·복잡·책임 있는 작업에서만. | **Phase 0 실험 B**(사용자 관찰)가 *코드 한 줄 전에* 이걸 때린다. Phase 1은 *한* 세그먼트만 정조준한 얇은 슬라이스라, 틀려도 손실이 작다. |
| **가치 ∝ (1 / AI 신뢰도)** (설계 §6.2) | **미검증·구조적.** 감독 욕구는 AI를 못 믿을 때 크고, 모델이 좋아질수록 *줄어든다*. "감독 도구"는 추세선과 싸울 위험. | 전략으로 뒤집는다: **AI 신뢰도가 계속 어려운 도메인**(새롭고·고위험·다중 시스템·판단 무거운 일)을 타깃. (런타임 히어로 보존은 §0대로 *엔지니어링* 근거이지 이 가정의 증거가 아니다.) |
| **감독 비용 < 감독이 아끼는 것?** (설계 §6.3) | **미검증·조건부.** 검사할 표면이 8개로 늘면 "PR 1개 대신 노드 8개 검사" = *더 나쁨*. 진짜 관리자는 재검토 안 함 — 집계 지표만 본다. | **`acceptance`/`evidence`를 1급으로** 만들어 "한눈에 초록/빨강" 검수를 가능케 한다(설계 §3.2). 이게 없으면 노드는 신뢰 불가. Phase 1이 *한* 노드에서 진짜 초록/빨강을 증명한다(**단 §7-4 참조**: Phase 1은 criterion 소수+노드 1개로 한정해 per-criterion 검증을 *근사*하고, 다중-criterion 러너는 그 다음). |
| **분해 품질이 충분히 좋은가** (설계 §6 / 로드맵 §0 실험 A) | **미검증·게이팅.** goal→그래프 출력이 쓰레기면 어떤 UI도 못 살린다. | **Phase 0 실험 A**(분해 실험)가 빌드 전에 *사람이* 판정. 생성기는 harness-kit 패턴의 **eval 하니스**와 함께 짓되, 하니스는 *실험 A에서 사람이 합격시킨 baseline 대비 회귀*만 막는다 — "감독할 가치가 있는가"는 하니스가 아니라 실험 A의 사람 판정이 정한다. |
| **`acceptance`가 trust-theatre가 아닌가** (설계 §6.3) | **미검증.** `SpecTask.done`처럼 *사람이 클릭*한 초록은 거짓 신뢰다. | verdict는 *시스템이 검증*해 채운다(`Criterion.verdict` + `evidenceRef`). 사람 토글 금지. (Phase 1은 §7-4대로 단일 워크스페이스 verdict로 *근사*하므로, 완전한 per-criterion 1급은 그 다음.) |

### 게이팅 질문

> **진통제(painkiller)인가, 비타민(vitamin)인가? 블랙박스가 정말 아플 만큼 아픈가?**

이게 코드를 더 짜기 전에 답해야 할 **단 하나의** 질문이다. 정답은 *맞다/틀리다*가 아니라
**"누구의 어떤 일에 대해서냐"**(설계 §7):

- 범용 "누구나 쓰는 AI 작업 OS" → **비타민일 공산이 크다.**
- 특정 세그먼트(복잡한 사내 시스템·멀티 시스템 통합·판단 무거운 일) → 여기선 **진통제일 수 있다.**

### VALIDATED vs UNVALIDATED (명확히)

> **축을 분명히 한다:** 여기서 "VALIDATED"는 *기술 기판이 작동·출시됨*을 뜻하지, *제품 방향이
> 옳다고 검증됨*이 아니다.

- **VALIDATED (기술 기판이 작동·출시됨 — 시장/제품 정당성은 별개):** 런타임-aware 디버깅 루프
  (CDP 증거 → 패치 → reload 검증)는 `roadmap.md`에서 출시·일상 사용. 캔버스 공간 엔진
  (pan/zoom/drag/edge/minimap)도 출시·작동. 에이전트 런타임(멀티턴·도구·승인·subagent)도 출시.
  — **단,** 이들을 떠받친 *런타임-에러-픽스 제품 프레이밍*은 이 피벗이 *떠나는* 프레이밍이다
  (이 문서 머리말의 "이전 프레이밍 — 대부분 출시됨"). 즉 검증된 것은 **엔진**이지, "이게 만들
  옳은 것이다"가 아니다.
- **UNVALIDATED (이 피벗의 핵심):** (1) 사람이 *과정을 감독*하고 싶어 한다는 전제,
  (2) goal→Task 그래프 *분해가 감독할 가치*가 있다는 것, (3) `acceptance`/`evidence`가
  감독 비용을 *절약하는 만큼* 좋다는 것. **이 셋이 Phase 0의 표적이다.**

---

## 5. 단계 (로드맵)

> **빌드보다 검증이 먼저.** 가장 큰 리팩터(§2)에 투자하기 전에 게이팅 질문부터 때린다.

### Phase 0 — 검증 (빌드 아님)

**실험 A — 분해 실험 (반나절 + 배선 비용).** 실제 업무 작업 2~3개(예: "주문 변경 기능 개발",
"런타임 에러 N 고치기", 사내 시스템 통합 하나)를 골라 LLM에게 §1 스키마(`WorkGraph`)대로 Task
그래프 JSON을 뽑게 한다. **새 UI는 불필요하나, 이 호출 자체가 신규 배선이다:** 레포는 오늘
`streamText`/`generateText`만 쓰고 `generateObject`/structured-output은 **어디에도 없다**. AI SDK의
`generateObject`는 동일 `ai` 패키지에서 import 가능하고(`ai@^6`), zod도 레포에 이미 있다
(`zod@^3.25.76`, 일부 tool 파일에서 사용 중)이라 *feasible*하지만, "기존 런타임 한 번 호출"이
아니라 **새 SDK 진입점 + provider-options 배선 + 스키마 검증층**을 세워야 한다. 검증은
zod 스키마로 하거나, `shared/work-os.ts`의 순수 타입가드(§1)로 hand-roll한다(레포가
`unknown`을 방어적으로 검증하는 방식 — `extractConsoleError`, canvas/store.ts의 `isNum`/`isStr`
가드와 일관). 따라서 "반나절 실험"도 *먼저 generateObject 경로를 세운 뒤*다.

[`agent/loop.ts`](../electron/agent/loop.ts)의 `streamText`는 **패턴 참고**(provider/model 배선
참고)이지, `generateObject` 호출의 reuse가 아니다.

- **판정(사람):** 이 분해가 *감독할 가치가 있을 만큼* 좋은가? 노드가 적절한 입도(粒度)인가?
  엣지(의존)가 말이 되는가? acceptance가 검증 가능한가? — 이건 green/red 하니스가 못 내리는
  질적 판단이다(§6 step 4).
- **주의:** `update_plan`/`AgentPlan`(평면 체크리스트)을 그래프로 착각하지 말 것 —
  엣지·acceptance·executor가 없다(§2 리스크).

**실험 B — 사용자 관찰 (3~5명).** 이 제품이 노리는 *종류의 일*(복잡·고위험·책임 있는
작업)을 하는 사람을 찾아 관찰한다. 핵심 질문: 그들은 **"라인을 감독"** 하고 싶어 하는가,
아니면 **"결과만 받고"** 싶어 하는가. = **진통제냐 비타민이냐.**

**Phase 0 게이트:** A가 "분해가 쓰레기"거나 B가 "다들 결과만 원함"이면 — **멈추고 재프레이밍**한다.
가장 큰 리팩터(§2)에 투자하기 전에.

### Phase 1 — 가장 얇은 수직 슬라이스 (몇 주)

증명할 루프는 **딱 하나: 생성 → 편집 → 실행 → 검증.**

```
목표 1개 입력
  → AI가 Task 그래프 생성 (실험 A의 생성기를 검증된 형태로)
  → 캔버스에 렌더 (CanvasStage 공간 엔진을 탭-무관 훅으로 추출 후 재사용 — §2 선행 추출)
  → 노드 1개 편집 (추가/삭제/순서 + acceptance 수정)
  → 노드 1개를 agent로 실행 (write-capable면 신규 headless 실행자; 읽기전용이면 runChildAgent)
  → output이 Resource로 노드에 뜨고, 클릭하면 도크에 열림 ("열기"만)
  → 실행된 노드는 acceptance 대비 통과/실패 표시 (진짜 초록/빨강; §7-4대로 단일 verdict 근사)
```

**Phase 1에서 빼야 할 것 (설계 §0 그대로):**

- **멀티 에이전트** — 한 번에 한 노드만 실행. 스케줄러·동시성·RTS 메타포 전부 제외.
- **풀 도구 통합** — 브라우저/에디터/터미널은 **"열기"만**. write-back, LRU, 도크 다중
  pane 관리 제외(단일 우측 드로어, 무한 캐시여도 OK인 슬라이스).
- **게임필/주스 일체** — 맨 마지막에, 절제해서.
- **선택적 재실행(ComfyUI식)** — 상류 변경→하류 recompute 제외(엣지 방향만 그려두되 propagation
  안 함).

### 그 다음 (코어 루프가 돈 이후)

1. **선택적 재실행** — `depends_on` 엣지를 따라 상류 변경 시 하류 Task를 `needs_review`로
   흔든다(Dagster/ComfyUI식 incremental). write-back(설계 부록)의 첫 조각.
2. **스펙 주도 검증 + 궤적 재생** — per-criterion 러너 + `formatEvidencePack`의 상위 컴포저로
   궤적을 직렬화·재생. acceptance가 다중 criterion을 진짜로 검증(Phase 1의 단일-verdict 근사를
   대체).
3. **멀티 에이전트 오케스트레이션 (RTS 지휘소 메타포)** — 엣지 순서를 walk하는 스케줄러 +
   기존 run-tree projection 재사용. 여러 노드 동시 실행 + 통합 승인 큐.
4. **write-back** — 도구에서의 변경(저장·명령 실행)이 Resource를 갱신하고 하류 Task status를
   흔든다(설계 부록).

---

## 6. Phase 1 파일별 작업 분해

> 그라운딩 기반. 신규 파일 / 변경 파일 / 가장 안전한 롤아웃. **classic 셸과 canvas-of-cards는
> 롤아웃 중 건드리지 않는다** (surface flag 뒤).

### 신규 파일

| 파일 | 내용 | 재사용 토대 |
|---|---|---|
| **`shared/work-os.ts`** | §1 스키마(`Task`/`Edge`/`Resource`/`Criterion`/`TrajectoryStep`/`WorkGraph`) + 타입가드(`isTaskStatus`/`isResourceKind`/`isEdgeType`). 순수, import 0. | [`shared/specs.ts`](../shared/specs.ts) `isSpecStatus` 패턴 |
| **`shared/resource-uri.ts`** | uri 스킴 인코딩/파싱 (`file:///…#L42`·`http(s)://`·`term://`·`db://`) + `resourceToOpenTarget`. `urlToWorkspacePath`(이미 있음)와 짝. | [`shared/runtime-evidence.ts`](../shared/runtime-evidence.ts) `urlToWorkspacePath` |
| **`src/features/work-graph/store.ts`** | `useWorkGraphStore` — Task/Edge CRUD + status 전이. placement는 `Task.id` 키. localStorage 키 **새 버전**(`maru.workgraph.v1`, `maru.canvas.v1`과 분리). | [`canvas/store.ts`](../src/features/canvas/store.ts)의 persist/prune 패턴 |
| **`src/features/canvas/useSpatialCanvas.ts`** (또는 `work-graph/`로) | §2 선행 추출 — `CanvasStage`의 wheel/pan/snap/connect/fit/minimap glue를 **탭-무관·opaque-node-id 키** 훅으로. `CanvasStage`와 `WorkGraphStage`가 둘 다 소비. viewport 수학은 기존 `useCanvasStore` 재사용. | [`canvas/CanvasStage.tsx`](../src/features/canvas/CanvasStage.tsx) (인라인 핸들러 추출), [`canvas/store.ts`](../src/features/canvas/store.ts) (`zoomAt/panBy/fitToContent`) |
| **`electron/agent/decompose.ts`** | goal → `WorkGraph` JSON 생성기. AI SDK `generateObject`(**레포 신규 진입점**) + 분해 system prompt + zod 또는 work-os 타입가드 검증. **Phase 1 심장.** `AgentPlan`과 무관. | [`agent/loop.ts`](../electron/agent/loop.ts) streamText는 *provider/model 배선 패턴 참고*(generateObject 호출은 신규), [`agent/plan.ts`](../electron/agent/plan.ts) 형태 참고(복사 아님) |
| **`electron/agent/decompose.eval.ts`** (harness) | 실험 A에서 사람이 합격시킨 **baseline 대비 회귀**를 막는 eval(harness-kit). baseline의 "감독할 가치" 여부는 하니스가 아니라 실험 A 사람 판정이 정한다. | `electron/harness-kit.ts` 패턴 |
| **`electron/agent/run-task.ts`** | 한 Task를 실행: `intent`+`acceptance`+`inputs`를 seed prompt로. **읽기전용/분석 Task** → `runChildAgent` 그대로(read-only toolset). **write-capable Task** → `runLoop`(현재 un-exported, L234)을 headless variant로 export하거나 신규 thin 실행자(approval/emit 최소화) — `startTurn`은 thread/approval/session 머신을 동반하므로 그대로는 무겁다. outputs+evidence+status 써넣기. | [`agent/subagent-runtime.ts`](../electron/agent/subagent-runtime.ts) (read-only child), [`agent/loop.ts`](../electron/agent/loop.ts) (runLoop/startTurn), [`agent/subagent-resolve.ts`](../electron/agent/subagent-resolve.ts) |
| **`src/features/dock/store.ts`** | `useDockStore` — `openResource(r)`/`focusPane(uri)`/`closePane(uri)`. uri 키 dedupe. **LRU는 Phase 1 제외**(무한 캐시 OK). | [`editor/store.ts`](../src/features/editor/store.ts) `openFile` dedupe |
| **`src/features/dock/ToolDock.tsx`** | Shell 형제. 단일 우측 드로어. `useDockStore` pane을 렌더. `WebContentsView` measure→`set-pane-bounds`(source=`dock:<ws>`) 소유. **scale=1/생략**으로 보내고 `getPaneScale`/`clearBrowserPaneBounds`와 조율해 도크 진입/이탈이 classic·canvas page zoom을 밟지 않게(§3 함정). | [`canvas/CanvasStage.tsx`](../src/features/canvas/CanvasStage.tsx) `measureWeb`, [`tabs/browserPaneBounds.ts`](../src/features/tabs/browserPaneBounds.ts) |
| **`src/features/dock/providers.tsx`** | `ToolProvider[]`(canOpen/open) + `resolveTool(r)`. editor/browser/terminal 3개. **editor/terminal은 `tabKinds` render 본문 재사용**; **web은 render를 쓰지 않는다** — grid/canvas 경로처럼 *측정 placeholder + 네이티브 뷰 합성*(set-pane-bounds) 경로(§2 "둘째 최대" refactor)를 탄다. | [`tabs/registry.tsx`](../src/features/tabs/registry.tsx) (editor/terminal render 시드; web은 measured-surface 경로) |
| **`src/features/work-graph/TaskNode.tsx`** | Task 요약 노드 본문: status chip · executor · acceptance 빨강/초록 · Resource 칩(클릭→`openResource`). `CanvasCard` **프레임 크롬을 카피해 참고**(드래그 헤더·resize·port·focus ring·@container), 본문 신규. **`tabKinds` import 없음**(경계 강제). 기존 `CanvasCard`는 불변. | [`canvas/CanvasCard.tsx`](../src/features/canvas/CanvasCard.tsx) 프레임(참고) |
| **`src/features/work-graph/WorkGraphStage.tsx`** | Task 노드 + 타입 있는 엣지만 렌더. **`useSpatialCanvas` 훅 소비**(추출된 공간 엔진). 도구 표면 없음, `measureWeb` 없음, `tabKinds` import 없음. | `useSpatialCanvas.ts`(신규 추출), [`canvas/CanvasEdges.tsx`](../src/features/canvas/CanvasEdges.tsx) |

### 변경 파일

| 파일 | 변경 |
|---|---|
| [`shared/specs.ts`](../shared/specs.ts) | `Criterion`(verdict 든) 추가 — `SpecTask`는 그대로 두되 acceptance는 `Criterion[]`로. |
| [`src/features/canvas/CanvasStage.tsx`](../src/features/canvas/CanvasStage.tsx) | 인라인 wheel/pan/snap/connect/fit/minimap 핸들러를 신규 `useSpatialCanvas` 훅으로 추출하고 그 훅을 소비(동작 불변). `useTabsStore`/`tabId` 결합은 CanvasStage 쪽에만 남기고 훅은 opaque-node-id로 파라미터화. |
| [`electron/agent/loop-commands.ts`](../electron/agent/loop-commands.ts) | `runVerifyNote`의 PASS/FAIL을 *문자열*에 더해 **구조화 verdict 레코드**로도 반환(criterionId·status·checkedAt·evidenceRef). 기존 prose 경로 유지. |
| [`electron/agent/tools/runtime-tools.ts`](../electron/agent/tools/runtime-tools.ts) | `reload_and_verify`의 GONE/STILL PRESENT을 같은 verdict 레코드로 캡처(현재는 transcript에 버려짐). |
| [`shared/ipc-map.ts`](../shared/ipc-map.ts) | `IpcMap`에 `workos:decompose`(invoke goal→WorkGraph) + `workos:run-task`(invoke) + verdict 이벤트 추가. `shared/ipc.ts`가 이 맵을 re-export하며 `IpcMapIsComplete`/`EVENT_CHANNELS`를 들고 있으므로(ipc-map.ts L4 주석) 거기도 갱신. *(roadmap.md가 `shared/ipc.ts`로 부르는 것과 동일한 맵 — 타입은 ipc-map.ts, 완전성 가드는 ipc.ts.)* |
| [`shared/evidence-pack.ts`](../shared/evidence-pack.ts) | 단일 Capture가 아니라 *집합*(궤적 `TrajectoryStep[]` + per-criterion verdict)을 직렬화하는 상위 컴포저 추가. 기존 단일 직렬화 유지. |
| Shell 진입 (surface 라우팅) | `useSurfaceStore`에 **새 view-mode `workgraph`** 추가 — `WorkGraphStage` + `ToolDock`을 형제로 마운트. canvas/classic은 불변. |

### 가장 안전한 롤아웃

1. **surface flag 뒤에서.** `useSurfaceStore`에 `'workgraph'` 모드를 세 번째 옵션으로 추가
   (canvas / classic / workgraph). 기본은 canvas 그대로. e2e는 `maru.surface=classic`을 seed하므로
   **classic·canvas e2e 불변**(Phase 2C에서 한 패턴). 세 surface는 **상호 배타**라 도크와 캔버스
   bounds source가 동시 공급되지 않는다(§3 함정).
2. **`tabKinds`를 *옆에* 둔다, 교체하지 않는다.** classic split-grid와 canvas-of-cards가 여전히
   `tabKinds.render`로 디스패치한다(둘 다 default-seeded). `ToolProvider`는 `tabKinds` *옆에*
   추가하고 editor/terminal render 본문을 재사용 — 레지스트리를 in-place로 갈아엎지 않는다.
   (신규 `work-graph/`는 `tabKinds`를 import하지 않는다 — §3 경계.)
3. **도크 디스패치를 노드-as-Task와 *독립적으로* 먼저 검증.** 그라운딩 권고대로: Phase 1에서
   `resolveTool(scheme)`은 editor/browser/terminal 3개에 대한 *가장 멍청한* 버전이면 충분.
   "클릭 Resource → 형제 표면에 도구 열림"을 (별도 load-bearing인) 노드 리팩터 *전에* 증명.
4. **분해 생성기를 eval 하니스와 함께.** `decompose.ts`는 `decompose.eval.ts`가 그린일 때만
   캔버스에 배선한다. 단 **하니스 그린은 "감독할 가치 있음"이 아니라 "실험 A baseline 대비
   회귀 없음"을 뜻한다** — baseline 자체가 감독할 가치가 있는지는 하니스가 아니라 실험 A의 사람
   판정이 정한다(§4 / §5). 회귀 가드를 "ship 게이트"로 착각하면 게이트 자체가 trust-theatre가
   된다(§6.3가 경고한 실패 모드).
5. **node↔tab 정체성을 한 surface에서만 끊는다.** `maru.canvas.v1`(tabId 키)은 건드리지 않고
   `maru.workgraph.v1`(Task.id 키)을 새로 쓴다 — 반쪽 마이그레이션으로 orphan placement가
   생기지 않게.

---

## 7. 열린 결정 (Phase 1 전/중 확정 필요)

1. **canvas-of-cards가 Task 그래프와 *공존*하는가, 모드로?** (열림)
   - 후보: (A) `workgraph`를 세 번째 view-mode로 영구 공존, (B) Task 그래프가 canvas-of-cards를
     *대체*(canvas는 archive). Phase 1은 (A)로 시작(롤아웃 안전), Phase 0 결과가 (B)를 정당화하면
     이동. **결정 시 `maru-identity-and-canvas-design.md`에 backref를 추가**해 두 살아있는 문서가
     서로를 알게 한다(이 피벗이 그 문서의 도구-카드 전제를 反패턴으로 재평가하므로).
2. **도크는 기존 context drawer와 어떤 관계인가?** (열림)
   - 오늘 Shell에는 explorer/search/git rail + **context drawer**(SpecsPanel 등)가 있다. 도크가
     (A) 새 우측 드로어인가, (B) context drawer를 흡수·확장하나, (C) 별도 표면인가. Phase 1은
     (A) 단일 우측 드로어로 최소.
3. **persistence 키 & 마이그레이션.** (반쯤 결정)
   - `maru.workgraph.v1`을 신규로(§6 롤아웃 5). `maru.canvas.v1`은 불변. 단 Edge 타입/방향
     추가 시(만약 canvas Edge를 재사용했다면) 버전 범프 필요했을 것 — Task 그래프는 별 스토어라
     이 문제를 *회피*한다.
4. **acceptance를 *어떻게* 평가하나.** (열림 — 가장 load-bearing)
   - Phase 1 후보: criterion 텍스트를 (A) `reload_and_verify`(런타임 에러 시그니처), (B)
     `runVerifyNote`(워크스페이스 verify 명령), (C) `run_diagnostics`(타입체크) 중 하나로 매핑.
     granularity mismatch 주의(설계 §6.3 / 그라운딩 리스크): `runVerifyNote`는 *턴 1개당
     전체-워크스페이스 1개* pass/fail인데 acceptance는 *다중* criterion이다. Phase 1은 **노드 1개 ·
     criterion 소수**로 한정해 이 mismatch를 피하고, per-criterion 러너는 "그 다음"(§5)으로 미룬다.
     즉 §4의 "1급 초록/빨강"은 Phase 1에서 **1급 데이터 슬롯 + 단일 verdict 근사**이지 완전한
     per-criterion 검증이 아니다.
5. **`type:'human'` executor를 Phase 1에서 표현하나?** (열림)
   - 오늘 표현 전무. Decision 게이트/사람 작업은 Phase 1 스키마엔 두되, 실행은 agent만.
6. **scrub 경계가 영속 evidence와 함께 이동하는가.** (결정 필요)
   - `formatEvidencePack`이 영속·휴대용 아티팩트가 되면 `shared/scrub.ts` 경계가 *함께* 이동해야
     secret이 영속 파일로 새지 않는다. Phase 1 컴포저에 scrub을 명시적으로 건다.

---

### 부록 — 결정 로그

- **2026-06-13:** AI Work OS 설계 v0.1 정독 + 4-에이전트 코드베이스 그라운딩 종합. 이 로드맵 작성.
- **2026-06-13:** **긴장 명명** — 오늘 캔버스(`maru-identity-and-canvas-design.md`)는
  canvas-of-TOOL-CARDS(`CanvasCard`가 도구를 프레임 안에 렌더)이고, 비전은 그것을 反패턴으로
  거부한다. 중심 리팩터 = **card-as-tool → node-as-Task + tool-pane-in-dock.** (변경 대상
  문서에 backref 추가는 §7-1 공존/대체 결정 시 — 일방향 reconciliation 방지.)
- **2026-06-13:** **메타모델 못박음** — 노드 타입은 Task 하나. Goal=intent, Agent=executor,
  Decision=kind, Resource=Task에 매달림. 위치 = 신규 `shared/work-os.ts`(`AgentPlan`과 별개),
  union마다 타입가드 동반. `TaskEvidence.trajectory`는 id-주소화 step 목록(평면 문자열 아님).
- **2026-06-13:** **런타임 히어로 보존 결정** — CDP "AI가 도는 앱을 본다"는 폐기 아님.
  Task.evidence + browser ToolProvider로 흡수. `roadmap.md`의 출시분(증거 정규화·reload_and_verify)
  재사용. **단 보존은 엔지니어링 근거이지 §6.1 감독-가정의 증거가 아니다**(§0).
- **2026-06-13:** **검증-우선 채택** — Phase 0(실험 A 분해 + 실험 B 사용자관찰)을 *빌드 전*에.
  게이팅 질문 = 진통제냐 비타민이냐. 분해 baseline 합격은 *사람* 판정; eval 하니스는 회귀만 막음.
  가장 큰 리팩터(§2)에 투자하기 전에 게이트 통과 요구.
- **2026-06-13:** **"reuse" 라벨 보정** — `generateObject`는 레포 전무(신규 SDK 진입점);
  공간 엔진은 extract-then-reuse(인라인 핸들러); `runLoop`은 un-exported; `runChildAgent`는
  read-only라 write-capable Task엔 신규 실행자 필요. §2 표를 이에 맞춰 재분류.
- **2026-06-13:** **하드 경계 강제 방법 결정** — 캔버스/도크는 형제 컴포넌트 트리, 공유 store만
  통신. 강제는 신규 `work-graph/`(TaskNode·WorkGraphStage)를 **`tabKinds` import 없이** 짓고
  `no-restricted-imports`로 잠그는 것 + store 분리 + bounds source를 `dock:<ws>`로 이동. 기존
  `CanvasCard`는 도려내지 않는다(canvas-of-cards 불변).
- **2026-06-13:** **롤아웃 안전 결정** — `workgraph`를 세 번째 surface view-mode로 flag 뒤에
  추가. 세 surface 상호 배타. classic + canvas-of-cards는 롤아웃 중 불변(`tabKinds`를 옆에 둠,
  교체 아님). 신규 persistence 키 `maru.workgraph.v1`로 node↔tab 정체성을 한 surface에서만 끊음.
- **2026-06-13:** **(미결) Phase 0 게이트 미실행** — 실험 A/B 결과가 나오기 전엔 §5 Phase 1과
  §6 파일 분해는 *조건부 계획*이다. A가 "분해 쓰레기"거나 B가 "결과만 원함"이면 재프레이밍.
- **2026-06-13:** **(미결) 동반 문서 위치** — 설계 v0.1이 레포 밖
  (`C:/Users/duct1/Downloads/ai-work-os-design.md`)에 있어 검증 비대칭. 합의되면
  `docs/ai-work-os-design.md`로 이동해 ./ 상대경로로 링크.
