# Agentic Chat v5 — "챗에서 에이전트로" 마감 라운드 (벤치마크 기반 격차 메우기)

> 상태: **제안 (2026-06-07)** · 범위: 레퍼런스 에이전트(Claude Code/Codex/OpenCode/Pi) 대비
> marudesk에 **실제로 빠진 격차**만 골라 메운다. 진행 = **설계 먼저**.
> 동반: [v4 설계](./agentic-chat-v4-design.md) · [subagent 설계](./subagent-design.md) ·
> [background-agent 설계](./background-agent-design.md) · [context-mcp 설계](./context-mcp-design.md) ·
> [design-benchmark 2026-06](./design-benchmark-2026-06.md)
>
> 확정된 결정 입력(2026-06-07): **Plan 철학 = 풍부형(Claude/Codex식 Taskboard)** ·
> **진행 = 설계 문서 먼저**.

---

## 0. 이 라운드의 전제 — "이미 에이전트다"

벤치마크에 앞서 *현실 점검*부터 박는다. marudesk는 v3/v4 + subagent/background 라운드를 거치며
이미 **챗이 아니라 성숙한 에이전트 플랫폼**이다. 레퍼런스의 핵심 패턴 대부분이 이미 착지했다:

| 레퍼런스 패턴 | marudesk 현황 | 근거 |
|---|---|---|
| 에이전트 루프 (Pi/Claude) | ✅ multi-step 루프 (max 24) | [loop.ts](../electron/agent/loop.ts) |
| 핵심 도구 read/write/edit/bash (Pi) | ✅ + 70여 개(CDP/터미널/세션/메모리) | [context-mcp 설계](./context-mcp-design.md) |
| 멀티 프로바이더 (OpenCode/Pi) | ✅ 10+ provider + fallback chain | [model.ts](../electron/agent/model.ts) |
| AGENTS.md 계층 (Codex) | ✅ 전역+워크스페이스+중첩+모드 | [instructions.ts](../electron/agent/instructions.ts) |
| 샌드박스/승인 분리 (Codex) | ✅ read-only/ask/auto/plan + gated 툴 | [handlers.ts](../electron/agent/handlers.ts) |
| **자동 컨텍스트 압축** (Claude) | ✅ `agent.autoCompact` threshold 0.8 + tail 보존 | [loop.ts:660](../electron/agent/loop.ts#L660), [v4 §8.1](./agentic-chat-v4-design.md) |
| 메모리 (Claude auto-memory) | ✅ list/read/write_memory 도구 | [context-mcp 설계](./context-mcp-design.md) |
| MCP (Claude) | ✅ stdio+HTTP 외부 서버 | [mcp-external.ts](../electron/agent/mcp-external.ts) |
| Skills/플러그인 (Claude) | ✅ isolated-worker 플러그인 | [plugin-runtime 설계](./plugin-runtime-design.md) |
| host/server 분리 (OpenCode) | ✅ host/relay/mobile 3계층 | [bridge-model-b 설계](./bridge-model-b-design.md) |
| 도구결과 LLM/UI 분리 (Pi) | ✅ `{summary, text}` ToolResult | tools/types |
| 미니멀 시스템 프롬프트 (Pi) | ✅ ~350단어 | [prompts.ts](../electron/agent/prompts.ts) |
| 서브에이전트 (Claude/OpenCode) | 🟡 Phase 1(bounded read-only child) | [subagent 설계](./subagent-design.md) |
| 백그라운드 에이전트 | 🟡 Phase 1(detached + 트레이) | [background-agent 설계](./background-agent-design.md) |

**결론: 코어는 끝났다.** 그래서 이 문서는 "에이전트로 만들기"가 아니라, 레퍼런스엔 있는데
우리에겐 약하거나 없는 **5개 격차**를 닫는다. (이미 설계/구현된 것은 다시 계획하지 않는다 — 비-목표 §7.)

---

## 1. 리서치 요약 — 4개 레퍼런스가 가르치는 것

> 출처는 §부록 A. 각 도구가 *대표하는* 교훈만 추린다.

### 1.1 Claude Code — "풍부한 컨텍스트 엔지니어링 + 구조화 todo"
- `TodoWrite` 식 **구조화 작업 목록**을 모델이 직접 갱신 → 다단계 작업의 진행을 사용자가 본다.
- 서브에이전트 = 독립 컨텍스트 창(오염 방지). 메모리를 **UX로 표면화**(무엇을 기억하는지 보고/편집).

### 1.2 Codex CLI — "쓰기 전 검토 + 샌드박스/승인 분리"
- **Plan 모드: 계획만 만들고 멈춤 → 검토·승인 후 실행.** 우리도 plan 모드는 있으나 *프롬프트 문구*뿐,
  상태 추적 가능한 목록이 없다([prompts.ts `PLAN_MODE_SYSTEM`](../electron/agent/prompts.ts#L54)).
- 되돌릴 수 없는 행동(파일 쓰기/네트워크/워크스페이스 밖)은 **실행 전** 승인. = "**적용 전 diff**".

### 1.3 OpenCode — "터미널 Mission Control + Plan↔Build 듀얼 에이전트"
- TUI가 **작업판(taskboard)·시각 diff·상태 맵** 중심(스크롤 대화가 아님).
- Plan 에이전트(전략) ↔ Build 에이전트(실행) 토글. (우리 plan/auto 모드와 유사하나 *작업 산출물*이 없음.)

### 1.4 Pi Coding Agent — "미니멀리즘의 반례"
- 도구 4개 + <1000토큰 프롬프트로 충분. **계획은 별도 harness 모드가 아니라 파일에 쓰는 것**이 낫다(지속/협업/가시성).
- "모델 컨텍스트에 정확히 무엇이 들어가는지 통제 = 더 좋은 출력. 숨은 주입 금지, 모든 게 UI에 보여야."
- ⚠️ Pi는 풍부형 plan/서브에이전트에 회의적이다. 우리는 **데스크탑 멀티패널이 강점**이라 풍부형을 택하되
  (결정 §2), Pi의 경고를 반영해 *작업 목록을 모델이 추적할 상태로 강요하지 말고* 파일+UI 양면으로 둔다(§3.2).

### 1.5 공통 UI/UX 수렴 (Agent UX 패턴)
스크롤 대화는 데모용. 프로덕션 에이전트의 핵심 패턴:
**Taskboard**(목표→작업→하위작업) · **Activity timeline** · **Action receipt(무엇이/어디서/diff/롤백)** ·
**Plan→Validate→Execute 2페이즈** · **Autonomy 레벨** · **Memory 컨트롤** · **Safe failure(위험↑ 시 결정론 강등 + '막혔어요'→사람 인계)**.

---

## 2. 이번에 확정한 결정

| # | 질문 | 선택 | 근거 |
|---|------|------|------|
| P | Plan/Todo 철학 | **풍부형(Taskboard)** | 데스크탑 멀티패널 강점 활용; OpenCode Mission Control 방향 |
| 순서 | 무엇부터 | **설계 문서 먼저** (이 문서) | 프로젝트 *design-first* 원칙([roadmap §9](./roadmap.md)) |
| 범위 | 무엇을 닫나 | **5개 격차만** (§3) | 코어·자동압축·서브에이전트 트리는 이미 있음/설계됨 → 재계획 금지 |

---

## 3. 5개 격차와 설계

우선순위순. 각 격차마다 *현재 → 목표 → 마이그레이션*.

### G1 (P0). 적용 전 diff 프리뷰 — "Plan→Validate→Execute" 2페이즈

**현재:** `edit_file`/`multi_edit`가 디스크에 **먼저 적용**한 뒤(atomic, [shared/patch.ts](../shared/patch.ts)),
`ChangesSection`이 accept/revert를 제공한다([Cards.tsx](../src/features/agent/chat/Cards.tsx)).
ask 모드에서도 "파일 편집은 바로 적용"([prompts.ts:78](../electron/agent/prompts.ts#L78)).
→ 가역적이지만 **사후(post-hoc)**다. Codex/Claude/OpenCode는 **쓰기 전** diff를 보여주고 승인받는다.

**목표:** 승인 모드별로 쓰기 시점을 선택.
- **새 모드 또는 설정 `agent.editApproval`**: `auto-apply`(현행) | `preview`(쓰기 전 diff 승인).
- `preview`일 때: 편집 도구가 디스크에 쓰기 전에 patch를 `pendingApproval`로 park → `ApprovalCard`에
  **파일별 diff**를 렌더(기존 diff 뷰어 재사용) → 사용자가 파일 단위로 Allow/Deny → 승인분만 `applyPatch`.
- read-only/plan 모드는 이미 쓰기 차단이라 무관. auto 모드 기본 = `auto-apply`(속도 유지).

**근거(Pi 경고 반영):** 풀 프리뷰는 자율 속도를 죽인다 → **기본값은 현행 auto-apply 유지**,
preview는 opt-in. "되돌릴 수 없음의 비용"이 높은 사용자만 켠다.

**마이그레이션:**
- [shared/settings.ts](../shared/settings.ts) — `agent.editApproval: 'auto-apply' | 'preview'` (기본 `auto-apply`).
- [electron/agent/loop.ts](../electron/agent/loop.ts) — 편집 도구 dispatch에서 `preview`면 applyPatch 전 park.
- [handlers.ts](../electron/agent/handlers.ts) — pendingApproval에 `kind:'edit'` + patch ops 첨부.
- [shared/agent.ts](../shared/agent.ts) — `AgentApprovalRequest`에 diff 페이로드(경로+before/after) 필드.
- [Cards.tsx](../src/features/agent/chat/Cards.tsx) — `ApprovalCard`에 파일별 diff + per-file Allow/Deny.

### G2 (P1). 풍부형 Plan/Todo + Taskboard 패널 ★ 핵심

**현재:** plan 모드는 read-only + "끝에 계획을 글로 써라" 프롬프트뿐([PLAN_MODE_SYSTEM](../electron/agent/prompts.ts#L54)).
**상태 추적 가능한 작업 산출물이 없다.** 다단계 작업의 진행을 사용자가 구조적으로 볼 수 없다.

**목표(풍부형 — 확정):** 모델이 갱신하는 구조화 plan + 데스크탑 사이드 Taskboard.
- **`update_plan` 도구**(Codex `update_plan`/Claude `TodoWrite` 패리티): 모델이
  `{ steps: { id, title, status: 'pending'|'in_progress'|'done', note? }[] }`를 제출/갱신.
  - gated 아님(상태 갱신은 부작용 없음). plan 모드뿐 아니라 **모든 모드에서** 호출 가능
    (복잡 작업의 진행 표시는 plan 전용이 아니다 — Claude/Codex 동일).
- **상태 보관:** `AgentChatState`에 `plan: AgentPlan`(steps 배열). 모델이 도구로 갱신 → emit.
  - Pi 경고 반영: plan은 **모델이 강제로 추적해야 하는 숨은 상태가 아니라** 산출물이다.
    한 step만 `in_progress`로 두도록 도구 스키마에서 권고(강제 아님), 미갱신해도 루프는 진행.
- **Taskboard UI(데스크탑 강점):** 채팅은 사이드, 메인 보조 영역에 작업판.
  - 목표 → steps(상태칩: ○ pending / ◐ in_progress / ● done) + 진행률 바.
  - step 클릭 → 그 step에서 변경된 파일/도구 호출로 점프(Activity timeline 연계).
  - 드로어 변형(좁은 창)에서는 트랜스크립트 상단에 접이식 plan 요약.
- **Plan 모드 연계:** plan 모드 종료 시 마지막 `update_plan` 산출물을 **그대로 실행 체크리스트로** 승격
  (현재는 글만 남고 사라짐). "계획 승인 → execute"가 Codex 2페이즈와 동형이 된다.

**마이그레이션:**
- [shared/agent.ts](../shared/agent.ts) — `AgentPlan`/`AgentPlanStep` 타입 + `AgentChatState.plan`.
- [electron/agent/tools/](../electron/agent/) — `update_plan` 도구 정의 + executor(상태만 갱신, persist).
- [prompts.ts](../electron/agent/prompts.ts) — 시스템 프롬프트에 "복잡(>~3 step) 작업은 update_plan으로
  계획·갱신" 한 줄 + plan 모드 종료 시 plan 보존 안내.
- [src/features/agent/](../src/features/agent/) — `Taskboard.tsx`(신규) + AgentChat에 패널 슬롯.
- [chat/format.ts](../src/features/agent/chat/format.ts) — step↔tool/edit 연결 메타.

### G3 (P1). 모델별 프롬프트 특화

**현재:** 시스템 프롬프트가 generic([prompts.ts](../electron/agent/prompts.ts)). Claude(extended thinking)·
GPT-5(reasoning_effort)·Grok은 추론/도구 방언이 다른데 같은 문구를 받는다.

**목표:** `getSystemPrompt(provider, modelId, mode)`로 분기.
- Claude: extended thinking 활용 가이드(이미 [reasoning-config.ts](../electron/agent/reasoning-config.ts) thinking_budget).
- GPT-5/codex: reasoning_effort 포맷 + codex 백엔드 제약 언급.
- Grok: 네이티브 reasoning 없음 → 명시적 step-by-step 유도.
- vision-capable 모델: 이미지 컨텍스트 활용 한 줄.
- **Pi 경고 반영:** 분기해도 각 변형은 여전히 짧게(<~500단어). 장황한 규칙은 프롬프트가 아니라 도구 description으로.

**마이그레이션:** [prompts.ts](../electron/agent/prompts.ts) — `SYSTEM_PROMPT` 상수 → `getSystemPrompt(...)`;
[loop.ts](../electron/agent/loop.ts) 호출부 교체. [shared/provider.ts] 능력 플래그(reasoning/vision) 이미 있으면 재사용.

### G4 (P1/P2). 실패 복구 루프 — "Safe failure"

**현재:** 도구 에러(파일 없음/edit oldString 불일치/테스트 실패) 시 결과만 모델에 돌려준다.
hatchworks "Safe failure & recovery"(위험↑ → 결정론 강등 + "막혔어요" → 사람 인계)가 없다.

**목표:**
- **자동 재시도(bounded):** 같은 도구가 연속 실패하면 1~2회 한해 "이전 시도가 [에러]로 실패. 다른 접근을"
  힌트를 tool result에 덧붙여 재유도. 총 재시도 카운터로 무한 루프 차단(max 24 step과 별개).
- **인계 트리거:** 같은 step에서 N회(기본 3) 실패 또는 동일 에러 반복 → 자동 `ask_user`로 사람에게 인계
  ("여기서 막혔습니다: …. 어떻게 진행할까요?"). G2 plan step을 `blocked` 상태로 표시.
- **stale-edit 가드 강화:** 이미 [read-tracker.ts](../electron/agent/)가 해시로 oldString 변경을 잡음 →
  실패 시 위 재시도 경로로 합류(파일 재읽기 유도).

**마이그레이션:** [loop.ts](../electron/agent/loop.ts) 도구 결과 처리부에 실패 카운터 + 재시도/인계 분기.
[shared/agent.ts] plan step `blocked` 상태. [shared/settings.ts] `agent.recovery.maxRetries`.

### G5 (P2). 메모리 컨트롤 UI

**현재:** `list/read/write_memory` 도구는 있으나([context-mcp 설계](./context-mcp-design.md))
**사용자가 보고/편집/삭제하는 패널이 없다.** Claude/hatchworks "Memory Controls" 패턴 미충족.

**목표:** Settings에 Memory 패널 — 저장된 메모리(markdown) 목록 + 보기/편집/삭제 + per-workspace 스코프 표시.
"에이전트가 무엇을 기억하는가"를 사용자가 통제(신뢰·프라이버시).

**마이그레이션:** [src/features/settings/](../src/features/settings/) — `MemorySettings.tsx`(신규).
기존 memory 도구의 백엔드(읽기/쓰기/삭제)를 IPC로 렌더러에 노출.

---

## 4. UI/UX 방향 — "대화가 아니라 워크스페이스"

데스크탑 멀티패널 = OpenCode "Mission Control" 방향이 최적. 다행히 관찰성 UI의 절반은 이미 있다
(DevTools 패널·런타임 증거·diff 뷰어). 추가/강화할 것:

| 패턴 | 현황 | 이 라운드 |
|---|---|---|
| Taskboard (목표→step) | ❌ | **G2 신설** |
| Activity timeline | 🟡 tool card 그리드 | step↔tool 연결(G2)로 강화 |
| Action receipt + diff | 🟡 사후 ChangesSection | **G1 사전 diff** + 파일별 승인 |
| Plan→Validate→Execute | 🟡 plan 모드(글만) | **G1+G2**로 완성 |
| Autonomy 레벨 | ✅ read-only/ask/auto/plan | 라벨을 "Suggest/Draft/Execute"로 재프레이밍(옵션) |
| Memory 컨트롤 | ❌(도구만) | **G5 패널** |
| Safe failure | ❌ | **G4 인계** |

채팅 surface는 사이드/드로어로, 메인 보조 영역에 Taskboard + diff 프리뷰. 좁은 창은 접이식 요약으로 graceful degrade.

---

## 5. 마이그레이션 맵 (파일별)

**추가**
- `src/features/agent/Taskboard.tsx` — 작업판(G2).
- `src/features/settings/MemorySettings.tsx` — 메모리 컨트롤(G5).
- `electron/agent/tools/update-plan.ts`(또는 기존 도구 파일 확장) — `update_plan`(G2).

**수정**
- `shared/agent.ts` — `AgentPlan`/`AgentPlanStep`, `AgentChatState.plan`, `AgentApprovalRequest` diff 페이로드, step `blocked`.
- `shared/settings.ts` — `agent.editApproval`(G1), `agent.recovery.maxRetries`(G4).
- `electron/agent/loop.ts` — 사전 diff park(G1), 실패 재시도/인계(G4), `getSystemPrompt` 호출(G3), plan emit(G2).
- `electron/agent/handlers.ts` — edit 승인 요청 kind(G1).
- `electron/agent/prompts.ts` — `getSystemPrompt(provider,model,mode)`(G3), update_plan 안내(G2), plan 보존(G2).
- `src/features/agent/chat/Cards.tsx` — ApprovalCard 파일별 diff(G1).
- `src/features/agent/chat/format.ts` — step↔tool 메타(G2).
- `src/features/agent/AgentChat.tsx` — Taskboard 패널 슬롯(G2).

**제거**
- 없음. (자동압축·서브에이전트 트리·MCP 등은 이미 있음/별도 문서 → 건드리지 않음.)

---

## 6. 단계 계획

| 단계 | 격차 | 한 줄 | 비고 |
|------|------|------|------|
| **G1** | 적용 전 diff | edit preview 승인(opt-in) | 작고 명확한 승리; 기존 diff 뷰어 재사용 |
| **G2** | Taskboard | update_plan 도구 + 작업판 패널 | 임팩트 최대; 데스크탑 강점 |
| **G3** | 모델별 프롬프트 | getSystemPrompt 분기 | 작음 |
| **G4** | 실패 복구 | 재시도 + 사람 인계 | G2 plan step blocked와 연계 |
| **G5** | 메모리 UI | Settings 패널 | 도구 백엔드 재사용 |

병행: G3·G5는 G1/G2와 독립. G4는 G2(plan step 상태) 뒤가 자연스럽다.
각 단계 후 `npm run typecheck` + `npm run build`, UI 변경은 실제 surface 수동 점검(AGENTS.md 검증 규칙).

---

## 7. Non-goals / 이미 있어 재계획하지 않는 것

- **자동 컨텍스트 압축** — 이미 구현([loop.ts:660](../electron/agent/loop.ts#L660), [v4 §8.1](./agentic-chat-v4-design.md)).
- **서브에이전트 full tree / 통합 승인 큐 / 병렬 패널** — [subagent 설계 §12](./subagent-design.md)에서 다룸.
- **백그라운드 에이전트 알림/취소 버튼** — [background-agent 설계](./background-agent-design.md) v1 연기 항목.
- **외부 MCP Prompts/Resources 와이어링** — [v4 §B5](./agentic-chat-v4-design.md) future.
- **로컬 임베딩 RAG 인덱스** — grep/list_files로 충분히 동작 중. 측정 후 필요하면 별도 라운드.
- **팀/조직 정책(모델 화이트리스트 등)** — 단일 사용자 범위 유지([roadmap](./roadmap.md)).
- Pi식 풀-미니멀 회귀(서브에이전트 제거 등) — 데스크탑 강점과 상충, 채택 안 함.

---

## 8. 열린 결정 (구현 전 확정)

- **G1 새 모드 vs 설정 플래그:** preview를 5번째 승인 모드로 노출할지, ask/auto의 `editApproval` 설정으로
  둘지. → 모드 폭발 방지 위해 **설정 플래그** 잠정 채택(재논의 가능).
- **G2 Taskboard 위치:** 항상 보이는 사이드 패널 vs 진행 중일 때만 펼침. → dogfood로 결정.
- **G4 인계 임계값:** maxRetries 기본값(2) / 인계 N(3) — dogfood로 튜닝.

---

## 부록 A — 출처

레퍼런스(2026-06 재확인):
- Mario Zechner — *Building a minimal coding agent (Pi)* — 미니멀 철학, 파일기반 plan, 컨텍스트 통제.
- OpenCode docs / agents — Mission Control TUI, Plan↔Build 듀얼 에이전트, client/server.
- OpenAI Codex — Agent approvals & security, AGENTS.md, plan 2페이즈, 샌드박스 3단계.
- Claude Code — memory(CLAUDE.md + auto-memory), 자동 compaction, 서브에이전트, TodoWrite.
- hatchworks / fuselab / agentic-design — Agent UX 패턴(Taskboard, receipt, safe failure, memory controls).

(URL은 채팅 리서치 로그 참조 — 문서에는 도구별 교훈만 박는다.)

---

### 부록 B — 결정 로그

- **2026-06-07:** 4개 레퍼런스(Claude Code/Codex/OpenCode/Pi) + Agent UX 패턴 벤치마크.
  현실 점검 = "이미 에이전트". 자동압축·서브에이전트·백그라운드는 이미 있음/설계됨 확인 → 재계획 제외.
- **2026-06-07:** 진짜 격차 5개 확정(G1 사전 diff / G2 풍부형 Taskboard / G3 모델별 프롬프트 /
  G4 실패 복구 / G5 메모리 UI). Plan 철학 = **풍부형(Taskboard)**, 진행 = **설계 먼저** 결정.
</content>
</invoke>
