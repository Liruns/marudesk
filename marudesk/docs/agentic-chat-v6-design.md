# Agentic Chat v6 — "성숙한 표면을 단단하게 + 2세대 레퍼런스 UI/UX 흡수"

> 상태: **제안 (2026-06-07)** · 범위: v5(G1~G5 + H1~H10) 착지 *이후*, 2세대 데스크톱
> 에이전트(Codex app / oh-my-pi / pi-gui / Claude Desktop / openagent류) 대비 **실제 격차**와,
> "있지만 미흡한" 기존 기능을 코드 감사 증거로 닫는다. 진행 = **설계 먼저**.
> 동반: [v5 설계](./agentic-chat-v5-design.md) · [subagent 설계](./subagent-design.md) ·
> [background-agent 설계](./background-agent-design.md) · [plugin-runtime 설계](./plugin-runtime-design.md) ·
> [roadmap](./roadmap.md)
>
> 이 라운드의 두 축(사용자 요청): **(W) 있는데 미흡한 기능** · **(G) 새로 가져올 기능** —
> 그리고 둘을 잇는 **(U) UI/UX 흡수**.

---

## 0. 전제 — v5 이후 현실 점검

v5에서 코어 격차(G1 사전 diff · G2 Taskboard · G3 모델별 프롬프트 · G4 실패 복구 · G5 메모리 UI)와
하드닝 10건(H1~H10)이 전부 착지했다([v5 §3·§H](./agentic-chat-v5-design.md)). 그래서 v6는 "에이전트
만들기"가 아니라 **두 가지**다:

1. **W (미흡 보강):** v5가 "있다"고 표시했으나 2026-06-07 코드 재감사에서 *부실/얕음/취약*으로
   확인된 지점. (file:line은 감사 시점 기준, 구현 시 재확인.)
2. **G (가져올 것):** 2세대 레퍼런스에는 있는데 우리에겐 *아예 없는* 능력.

> ⚠️ 원칙(v5 계승): "있음 ≠ 잘 됨." 그리고 "없음이라고 다 짓지 않는다" — dogfood로 매일 켜는
> 동선에 닿는 것만. moat가 아니라 *데일리 훅 + 포트폴리오*가 나침반([roadmap §1](./roadmap.md)).

---

## 1. 리서치 요약 — 2세대 레퍼런스가 가르치는 것

> 출처 §부록 A. 도구별 *교훈*만 추린다. v5는 CLI 세대(Claude Code/Codex CLI/OpenCode/Pi)였고,
> v6는 그 위에 올라온 **데스크톱 앱 세대**를 본다.

### 1.1 Codex desktop app — "대화가 아니라 작업 보드"
- **병렬 thread + 프로젝트 사이드바**: 작업을 thread 단위로 동시에, 프로젝트별 그룹. 컨텍스트 전환 무손실.
- **thread 실행 모드: Local / Worktree / Cloud** — 위험 작업을 git worktree로 격리.
- **Diff pane + 그 위 inline 코멘트**: hunk에 코멘트 → 에이전트가 그 자리에서 반영.
- **Task sidebar(라이브)**: plan / sources / 생성 artifact / 요약을 *실행 중* 추적·steer.
- **In-app browser + 페이지 요소 코멘트**, **Automations**(스케줄+프롬프트, 컨텍스트 유지),
  승인 "한 번만 vs 세션 전체", pop-out always-on-top, 음성 받아쓰기.

### 1.2 oh-my-pi — "엔진 신뢰성과 라우팅"
- **Hash-anchored edits(Hashline)**: content-hash anchor + stale anchor 거부 → "string not found"
  루프 제거, 출력 토큰 대폭 절감. (우리 edit 취약점 W1의 직접 해법.)
- **AST 기반 rewrite(ast-grep)** preview→accept 스테이징.
- **모델 4역할 라우팅**(default/smol/slow/plan) + 세션 중 모델 사이클 + path-scoped 오버라이드.
- **/review = 병렬 reviewer subagent + P0~P3 우선순위 + confidence + ship 판정.**
- 카드형 tool-call 렌더링 / ask() 옵션 피커.

### 1.3 Claude Desktop — "챗 안의 인터랙티브 표면 + 원클릭 확장"
- **원클릭 MCP/확장 설치(.mcpb)** — config 수동편집 제거.
- **Artifacts / Live Artifacts / MCP Apps**: 챗 창 안에 차트·폼·대시보드 같은 *인터랙티브 UI*.
  (우리 플러그인 iframe 런타임과 구조적으로 호환 → 재활용 가능.)

### 1.4 pi / pi-gui — "미니멀 코어, 네이티브 셸"
- 네이티브 데스크톱: 멀티 워크스페이스 + persistent 세션 히스토리. (우리 이미 보유 → 비-목표.)
- 경고 계승: 라우팅·아티팩트를 더해도 *숨은 주입 금지, 모든 게 UI에 보여야*.

### 1.5 openagent류 — "멀티에이전트 협업"
- 공유 thread/파일 위 @mention 협업, RAG 지식베이스. → **v6 비-목표**(단일 사용자·subagent로 충분,
  과투자). 단 *병렬 thread*(§G2)는 협업과 별개로 채택.

---

## 2. 결정 (제안 — 리뷰에서 확정)

| # | 질문 | 결정 (2026-06-07 확정) | 근거 |
|---|------|------|------|
| A | v6 범위 | **전부 — W + G + U 풀스코프(병렬 thread/worktree/automations/아티팩트 포함)** | 데스크톱 강점 풀가동; 큰 베팅(§단계 12)은 내부적으로 쪼개 진행 |
| A' | 착수 순서 | **차별점 U1/U2(코멘트) 먼저 → W(신뢰) → 관리 UI → 큰 베팅** | dogfood·포트폴리오 임팩트가 코멘트 기반 조종에 있음(USP) |
| B | edit 엔진 | **Hashline 도입(W1)** | 모든 edit 기반 작업의 신뢰성 상승. v5 G1과 **보완관계**(G1=*언제*/preview, W1=*어떻게*/매칭) |
| C | 병렬성 모델 | **thread 병렬 + worktree (v6 포함, 단계 12에서 쪼개기)** | 데스크톱 강점·Codex 패리티 |
| D | 아티팩트 | **플러그인 iframe 런타임 재활용** | 새 샌드박스 안 만든다 |
| E | 협업 멀티에이전트 | **비채택** | 단일 사용자 범위([roadmap](./roadmap.md)) |

> **모바일 패리티(v5 계승):** U5(steerable plan)·U10(승인 토글)·W4/U3(라이브)는 모바일 thin client에
> 투영되는 surface다 — v5처럼 데스크톱 구현 시 [mobile/](../../mobile/) PlanBoard/ApprovalPrompt 패리티를
> 같은 단계에서 맞춘다(미루지 않는다).

---

## W. 미흡한 기존 기능 (코드 감사 2026-06-07, file:line 증거)

> 심각도: **brittle(자주 깨짐) > stub(표면 없음) > thin(2차 흐름 부재)**. v5 §H 번호와 겹치지 않게 W로 표기.

### W1 (P0, brittle). edit/diff 문자열 매칭이 정확매칭뿐
- **증상:** [shared/patch.ts:132-147](../shared/patch.ts#L132)가 `indexOf(op.oldString)` 정확매칭만.
  공백/들여쓰기/CRLF 한 글자 차이 → "oldString not found"로 **전체 실패**. self-heal은 line-numbered
  현재내용을 돌려주고([file-tools.ts:257-270](../electron/agent/tools/file-tools.ts#L257)) 모델이 수동 재craft.
- **수정(=G, oh-my-pi Hashline — 하이브리드, 열린결정 4):** **B 주축 + A 폴백**.
  - **B(주축):** 읽기뷰가 줄 단위 **해시 앵커**를 emit → 모델이 verbatim 복제 대신 앵커로 편집 →
    해시로 정확 적용(토큰↓·애매함 제거). stale 앵커 거부.
  - **A(폴백):** 앵커 없음/stale/약한 모델이면 hard-fail 대신 **공백·CRLF 정규화 + fuzzy 매칭**으로
    바닥 보장(애매하면 거부, 오매칭 방지). ast-grep 구조 매칭은 2차.
  - **착수:** 단계 3에서 **A 폴백 먼저**(전 모델 즉시 실패 감소) → B(해시뷰+앵커) 얹어 천장.
  - `patch.ts`/`file-tools.ts`(읽기뷰 해시)/`executors.ts` 변경. B는 프롬프트에 앵커 포맷 1줄.
- **검증:** 들여쓰기/CRLF/trailing-blank harness + **edit 실패율 before/after** + (B) **출력 토큰 절감** 측정.

### W2 (P0, stub). 플러그인 설치/관리 UI 전무
- **증상:** [PluginPanel.tsx](../src/features/plugins/PluginPanel.tsx)는 *이미 설정된* 플러그인 패널만
  렌더. 추가/제거/업데이트/디스커버리 UI 0개 — `userData/plugins.json` 수동편집만
  ([electron/plugins/config.ts](../electron/plugins/config.ts)). H9에서 engine semver는 검사하나
  버전 업그레이드 UX 없음.
- **수정(=G, Claude .mcpb / Codex Skills picker):** Settings에 플러그인/MCP 관리 패널 — 설치(파일/URL)·
  활성토글·제거·버전/호환 표시. MCP 서버 관리(W6)와 한 surface로 합침.

### W3 (P1, thin). 메모리 발견성/수명
- **증상:** [MemorySettings.tsx](../src/features/settings/MemorySettings.tsx)는 이름+120자 프리뷰
  나열만 — **본문 검색 없음**. 500개 하드캡 도달 시 자동 evict 없이 **쓰기 거부**
  ([memory-store.ts:16-17,79-81](../electron/agent/memory-store.ts#L16)). dedup 없음(H8이 슬러그
  충돌만 처리).
- **수정:** **세션이 이미 쓰는 SQLite FTS5를 메모리에도 재활용**(본문 검색) + age/사용빈도 기반 자동
  eviction(또는 LRU) + 근사중복 경고. Settings 패널에 검색바.

### W4 (P1, thin). subagent/background 출력이 batch — 라이브 스트리밍 없음
- **증상:** 자식 출력이 단일 버퍼로 수집되어([subagent-runtime.ts:156-158](../electron/agent/subagent-runtime.ts#L156))
  끝나야 결과 카드 1개. traces는 정적 리스트. 부모/UI에 *진행*이 안 보임("fire and forget").
- **수정(=U, Codex task sidebar 라이브):** 자식 부분출력을 부모 스트림/사이드 패널에 라이브 표면화
  (Taskboard/Mission Control 재사용). H5(비용 롤업)와 같은 자식 채널 위에 얹음.

### W5 (P1, thin). 에러 복구 *UI* 부재
- **증상:** 도구 에러가 잘린 정적 텍스트뿐([Message.tsx:384-388](../src/features/agent/chat/Message.tsx#L384)).
  G4가 *모델측* 재시도/인계 힌트는 넣었으나, 사용자용 **retry/제안/맥락 affordance가 없다**.
- **수정(=U, Codex 실패 카드):** ErrorRecoveryCard — 실패 요약 + 흔한 원인 제안 + "재시도/수정 지시"
  버튼. G4 인계 트리거와 시각적으로 연결.

### W6 (P1, thin). MCP 복원력·게이팅 입도
- **증상:** 재연결 backoff는 있으나 5회 후 **circuit breaker 없이 영구 error**
  ([mcp-external.ts:725-729](../electron/agent/mcp-external.ts#L725)) — 일시 장애에서 자동 복구 안 됨.
  trusted 서버는 per-tool 게이팅 불가([mcp-external.ts:194-202](../electron/agent/mcp-external.ts#L194)).
- **수정:** 주기적 재시도(지수 backoff + 상한 후 idle 재시도) + trusted 서버에도 per-tool allow/deny.
  W2 관리 패널에 상태/재연결 버튼.

### W7 (P2, thin). 승인 입도 — semi-auto 없음 + "항상 허용" 휘발
- **증상:** 모드가 plan/read-only/ask/auto 4단(이진적). "읽기 자동, 쓰기 확인" 같은 semi-auto 없음.
  "항상 허용"이 [loop.ts:540-541](../electron/agent/loop.ts#L540) `sessionAllowedTools`(세션 휘발)라
  다음 세션 재질문. deny는 path glob만, tool-level deny 없음.
- **수정(=G, Codex "한 번만 vs 세션 vs 영구"):** semi-auto 모드 + 영구 allow/deny 저장(설정 영속) +
  per-tool deny ACL.

### W8 (P2, thin). /review 등 prompt slash가 단일패스
- **증상:** [slash-commands.ts:63-79](../shared/slash-commands.ts#L63) `/review`가 단일 템플릿 1회 턴.
  병렬 reviewer·심각도 등급·follow-up 없음.
- **수정(=G, oh-my-pi):** subagent(이미 보유)로 병렬 reviewer fan-out → P0~P3 집계. slash가
  orchestration 콜백을 갖도록 확장.

### W9 (P2, thin). compaction 요약 정적 / plan 모델 전용
- compaction: 요약이 읽기전용 markdown([Message.tsx:40-68](../src/features/agent/chat/Message.tsx#L40)),
  무엇이 압축됐는지 프리뷰/편집 불가. → **펼쳐보기/원문 미리보기** 추가(U).
- plan/Taskboard: 모델 전용, 사용자가 step 편집/재정렬/체크 불가([plan.ts](../electron/agent/plan.ts),
  [Cards.tsx:348-417](../src/features/agent/chat/Cards.tsx#L348)). → **steerable plan**(사용자 편집, U).

> 비-항목: 렌더러↔main IPC 자동재연결 — Electron main 크래시는 치명적이라 **의도된 설계**로 유지(감사 동의).

---

## G. 가져올 기능 (없던 능력)

> W의 "수정"이 곧 G인 항목이 많다(엔진/능력 import). 여기엔 *순수 신규 능력*만 따로 모은다.

### G1. Git worktree 실행 모드 (Codex)
- **현재:** 에이전트가 워크스페이스 디스크에 직접 패치. 격리 없음.
- **목표:** thread/세션별 git worktree에서 실행 → 위험 작업 격리, 비교 후 병합. 비-git 워크스페이스는
  현행 fallback. (G2 병렬 thread의 안전 기반.)

### G2. 병렬 thread + 프로젝트 사이드바 (Codex) ★ 큰 베팅
- **현재:** 세션 = *순차 히스토리*([SessionRail](../src/features/agent/SessionRail.tsx)). 동시 실행 없음.
- **목표:** thread를 동시 실행 단위로 승격, 프로젝트별 그룹 + Stage 탭/세션레일 재활용. background
  agent registry를 thread 모델로 일반화. **단계적으로 쪼갠다**(아키텍처 큼 — §단계 계획 참조).

### G3. Automations (Codex)
- **목표:** background agent 위에 스케줄(cron) + 저장된 프롬프트. 워크스페이스 worktree에서 백그라운드 실행.

### G4. 인터랙티브 아티팩트 / MCP Apps (Claude)
- **현재:** 이미지/비디오만 inline([Media.tsx](../src/features/agent/chat/Media.tsx)).
- **목표:** 챗/패널에 인터랙티브 HTML 아티팩트 — **플러그인 iframe 런타임(plugin:// 샌드박스)** 재활용,
  MCP/도구 결과를 차트·폼·대시보드로. 새 샌드박스 안 만든다(D 결정).

### G5. 모델 역할 라우팅 (oh-my-pi)
- **현재:** 모델 팔레트 + fallback 체인 보유([ModelPalette](../src/features/agent/ModelPalette.tsx)).
- **목표:** 역할(default/cheap/deep/plan)별 라우팅 + 빠른 사이클(단축키) + path-scoped 오버라이드.
  fallback 체인 확장으로 증분. 비용 절감.

---

## U. UI/UX 흡수 — "관찰·조종 가능한 워크스페이스"

> v5 §4 계승: 데스크톱 멀티패널 = Mission Control. 2세대가 더한 패턴 중 **우리 강점(브라우저+CDP 소유,
> 플러그인 iframe, 기존 diff 뷰어)에 맞는 것**만 흡수.

| 패턴 | 출처 | 현황 | v6 |
|---|---|---|---|
| **Diff 위 inline 코멘트** | Codex | 사후 ChangesSection / ApprovalCard diff | hunk 코멘트 → 에이전트 반영(**U1**, 기존 diff 뷰어 재사용) |
| **브라우저 요소 → 코멘트** | Codex | browser stage + CDP inspect 보유 | 요소 지목 피드백 → 에이전트(**U2**, *우리 USP에 정조준*) |
| **Task sidebar 라이브 피드** | Codex | Mission Control 패널(정적) | subagent/도구 진행 라이브(**U3** = W4) |
| **실패 복구 카드** | Codex | 정적 에러 텍스트 | retry/제안 카드(**U4** = W5) |
| **steerable plan** | Codex | 모델 전용 Taskboard | step 편집/재정렬/수동 체크(**U5** = W9) |
| **인터랙티브 아티팩트** | Claude | 이미지/비디오만 | iframe 아티팩트(**U6** = G4) |
| **모델 역할 팔레트 + 사이클** | oh-my-pi | 모델 팔레트 | 역할칩 + 단축키 사이클(**U7** = G5) |
| **플러그인/MCP 관리 패널** | Claude/Codex | config 파일만 | Settings 설치/관리 surface(**U8** = W2+W6) |
| **compaction 펼쳐보기** | Claude | 정적 요약 | 원문 미리보기(**U9** = W9) |
| **승인 "한 번/세션/영구" 토글** | Codex | 세션 휘발 | 영속 allow/deny(**U10** = W7) |

원칙: 채팅은 사이드/드로어, 메인 보조영역에 Taskboard+diff+아티팩트. 좁은 창은 접이식으로 graceful degrade.
브라우저 요소 코멘트(U2)와 diff inline 코멘트(U1)는 **marudesk의 "런타임을 몰고 검증한다" 테제와 정합** —
타 데스크톱이 흉내내기 어려운 차별점이라 U 중 최우선 후보.

---

## 마이그레이션 맵 (파일별, 잠정)

**추가**
- `electron/agent/tools/hashline.ts`(또는 patch.ts 확장) — hash-anchored 매칭(W1).
- `src/features/settings/PluginManager.tsx` + `McpManager.tsx`(또는 통합) — 설치/관리(W2/W6/U8).
- `src/features/agent/chat/ErrorRecoveryCard.tsx` — 복구 affordance(W5/U4).
- `src/features/agent/chat/DiffComment*.tsx` — diff inline 코멘트(U1).
- `electron/agent/tools/review-orchestrator.ts` — 병렬 reviewer(W8).

**수정**
- `shared/patch.ts` / `electron/agent/tools/file-tools.ts` — Hashline 매칭(W1).
- `electron/agent/memory-store.ts` — FTS 인덱스 + eviction(W3); `MemorySettings.tsx` 검색바.
- `electron/agent/mcp-external.ts` — circuit breaker 재시도 + per-tool 게이팅(W6).
- `electron/agent/loop.ts` + `shared/settings.ts` — semi-auto 모드 + 영속 allow/deny(W7/U10).
- `electron/agent/subagent-runtime.ts` + Taskboard/Mission Control — 라이브 스트리밍(W4/U3).
- `electron/agent/plan.ts` + `Cards.tsx` Taskboard — steerable 편집(W9/U5).
- `src/features/agent/chat/Media.tsx` + 플러그인 iframe — 아티팩트(G4/U6).
- `src/features/agent/ModelPalette.tsx` + fallback 체인 — 역할 라우팅(G5/U7).
- `electron/agent/background.ts` → thread 일반화(G2), 스케줄(G3).

**제거**: 없음(기존 surface 재활용 원칙).

---

## 단계 계획 + 권장 순서

**차별점(U) 먼저 → 신뢰(W) → 관리 UI → 큰 베팅**(결정 A·A'). 각 단계 1 PR 규모(에러복구/승인은 분리).

| 단계 | 항목 | 한 줄 | 규모 | 성공 기준(dogfood 판정) |
|------|------|------|------|------|
| **1** | U1 diff inline 코멘트 | hunk 코멘트 → 에이전트 반영 | 中 | 코멘트→반영 1왕복으로 수정 완료 |
| **2** | U2 브라우저 요소 코멘트 | 요소 지목 → 에이전트(*USP*) | 中 | inspect 요소 코멘트→패치→reload 검증 동선 |
| **3** | W1 Hashline (B 주축+A 폴백) | edit 신뢰성(엔진) | 中 | A 폴백: 전 모델 edit 실패율↓ / B: 출력 토큰↓ |
| **4** | W3 메모리 FTS+eviction | 세션 FTS 재활용 | 小~中 | 본문 키워드로 메모리 즉시 검색; 캡 도달 무중단 |
| **5** | W5/U4 에러복구 카드 | retry/제안 affordance | 中 | 실패 카드에서 1클릭 재시도/수정지시 |
| **6** | W7/U10 승인 입도 | semi-auto + 영속 allow/deny | 中 | 다음 세션에서 재질문 없음; 읽기자동/쓰기확인 |
| **7** | W8 /review 병렬 | subagent reviewer P0~P3 | 小~中 | 단일패스 대비 누락 발견 증가 |
| **8** | W4/U3 + W9/U5·U9 | subagent 라이브 + steerable/펼침 | 中 | 진행 라이브 가시; plan step 수동 편집 |
| **9** | W2/W6/U8 플러그인·MCP 관리 | 설치/관리 패널 | 中~大 | JSON 수동편집 없이 설치·토글·제거 |
| **10** | G5/U7 모델 역할 라우팅 | 역할칩 + 사이클 | 小~中 | cheap/deep 자동 라우팅으로 비용↓ |
| **11** | G4/U6 인터랙티브 아티팩트 | iframe 아티팩트 | 中~大 | 도구 결과를 차트/폼으로 챗 내 표시 |
| **12** | G1 worktree → G2 병렬 thread → G3 automations | 큰 베팅(쪼개기) | 大 | worktree 격리 → 동시 thread → 스케줄 실행 |

각 단계 후 `npm run typecheck` + `npm run build`, UI 변경은 실제 surface 수동 점검([AGENTS.md] 검증 규칙).
모바일 영향 단계(8의 U5, 6의 U10)는 `mobile/` 패리티 + smoke 동반. 단계 12는 worktree(기반) →
thread(승격) → automations 순으로 분리하고, 각 분리분이 독립 PR.

---

## S. 보안 검토 (코드 근거 2026-06-07)

> v6 신규 surface가 여는 위협을 *실제 코드의 기존 방어기제*와 대조했다. 결론: **기존 방어는 전반적으로
> 견고**(문서가 가정한 H9 DNS-pin·CDP allowlist·scrub 등 사실 확인). 남은 위험은 대부분 *정책 레벨*이라
> v6 기능마다 **요건**으로 박는다. file:line은 검토 시점 기준.

### S.0 검증된 기존 방어 (v6에서 재사용)
- **guardedFetch DNS-pin + SSRF** ([permissions.ts:127-162](../electron/plugins/permissions.ts#L127)) —
  lookup 후 IP pin, private/loopback/link-local + **metadata 169.254.169.254 차단**, redirect 미추적,
  TLS SNI 보존. (H9 주장 = 사실.) **STRONG**
- **plugin:// 샌드박스** ([protocol.ts:89](../electron/plugins/protocol.ts#L89)) — CSP `default-src 'none'`,
  **`connect-src 'none'`(망 유출 차단)**, base-uri/form-action none, 경로 traversal/심볼릭 거부. **STRONG**
- **scrub** ([scrub.ts:37-108](../shared/scrub.ts#L37)) — JWT/PEM/provider 키/민감 헤더 redact. **STRONG**(엔트로피 미탐지).
- **CDP allowlist** ([cdp.ts:71-115](../electron/browser/cdp.ts#L71)) — **`Page.navigate` 차단**, 위험 30+
  메서드 deny-first(setCookie/setBypassCSP/navigate…). **STRONG**
- **도구 게이팅** ([loop.ts:479-552](../electron/agent/loop.ts#L479), [types.ts GATED_TOOLS](../electron/agent/tools/types.ts#L72)) —
  read-only/plan write·eval_js 차단, ask 게이팅. **STRONG**
- **fs-safe 경계** ([fs-safe.ts:29-130](../electron/fs-safe.ts#L29)) — `..`/절대경로/심볼릭/NTFS-ADS 거부, atomic write, deny glob. **STRONG**
- **fetch_url/web_search** ([fetch-url.ts](../electron/agent/tools/fetch-url.ts)) — http(s)만, private/metadata 차단
  (매 redirect 재검), HTML→text+scrub, 크기캡. **STRONG**

### S.1 신규 surface별 요건 (P0 = 구현 전 필수)

| 기능 | 위협 | 기존 방어 | v6 요건 |
|---|---|---|---|
| **U2 브라우저 요소 코멘트** (P0) | 임의 웹페이지 DOM = **untrusted** → 프롬프트 인젝션 | fetch_url은 HTML→text+scrub하나 CDP `query_dom` 캡처 경로는 별도 | 요소 캡처를 **untrusted external data로 표기**(엔벨로프) + "페이지 내용의 지시 무시" 규칙 + fetch_url sanitize 재사용 |
| **G4/U6 인터랙티브 아티팩트** (P0) | iframe XSS / postMessage로 특권도구 호출 / 망 유출 | plugin:// 샌드박스 STRONG(`connect-src none`) | 아티팩트 = **plugin:// 샌드박스 그대로** + **tool/fs/http grant 0**(플러그인과 분리) + postMessage 브리지에 특권도구 미노출 → **열린결정 5 해소** |
| **G3 automations** (P0, *최고위험*) | 무인 스케줄 = auto 모드 = **게이팅 풀바이패스**(검증됨, loop.ts:515) | auto 모드는 전체 우회 | **blanket-auto 금지**: per-automation 도구 allowlist + **worktree 격리(G1)** + run_command/eval_js 기본 deny |
| **W7/U10 영속 승인** (P1) | run_command/eval_js 영구 자동승인 | 현재 session-scoped(안전) | 영속 allow = **per-tool + per-workspace 스코프** + 고위험 도구 opt-in + 관리 UI에서 취소가능. semi-auto = read자동/write확인 |
| **G2 병렬 thread** (P1) | 한 thread 승인이 타 thread로 누수 | `sessionAllowedTools` 전역 | 승인/allowlist **thread별 스코프**(현 plugin callId 상관 패턴 참고) |
| **W2 플러그인 설치 UI** (P1) | 임의 플러그인 설치 = 공급망 | 권한 grant+hash(TOFU), **서명/무결성 없음**(검증된 gap) | 설치 시 **선언 권한 + 출처 노출 후 승인**, URL 설치 경고, (옵션) 무결성 체크 |
| **G1 worktree** (P2, 보안 *positive*) | 격리되나 경계 재설정 | fs-safe root | fs-safe root = **worktree 경로**, deny glob 유지 |
| **W6 MCP per-tool 게이팅** (보안 *positive*) | (현재 binary trust = coarse, 검증된 gap) | server 단위 trust | per-tool allow/deny = **least-privilege 개선** |

### S.2 알려진 기존 gap (v6 비차단, 추적만)
- **플러그인 manifest 서명 없음(TOFU)** — 승인 후 권한 불변 매니페스트 변경은 무재승인 적용. W2 설치 UI가 부분완화.
- **scrub 엔트로피 미탐지** — 신규/무명 포맷 고엔트로피 토큰 누출 가능. (파일 차단이 1차 방어라 영향 제한적.)
- **fetch_url = blocklist(allowlist 아님)** — 기업용 per-workspace allowlist는 별도 라운드.
- **plugin `script-src 'unsafe-inline'`** — XSS 여지나 `connect-src none`이 유출은 차단.

---

## Non-goals

- **협업 멀티에이전트(@mention/공유 thread)** — 단일 사용자 범위, subagent로 충분([roadmap](./roadmap.md)).
- **Cloud 실행 모드** — Codex의 Local/Worktree/Cloud 중 Cloud는 우리 로컬 소유 테제와 상충.
- **컴퓨터 사용(데스크톱 클릭/타이핑 자동화)** — 범위 폭발, 보안 표면 큼.
- **로컬 임베딩 RAG** — grep/list로 충분(v5 계승), 측정 후 별도 라운드.
- **음성 받아쓰기 / pop-out / 이미지 생성 in-thread** — nice-to-have, 데일리 훅 약함 → 보류.

---

## 열린 결정

**해소(2026-06-07 리뷰):**
1. ~~W vs 차별점 비중~~ → **차별점 U1/U2 먼저**(결정 A').
2. ~~병렬 thread 착수 시점~~ → **v6 포함**, 단계 12에서 쪼갬(결정 A·C).
3. ~~U1/U2 우선순위~~ → **단계 1~2로 상향**(결정 A').
4. ~~Hashline 도입 방식~~ → **하이브리드(B 주축 + A 폴백)**. 근거: 진짜 비용은 (1) edit 실패 재시도
   루프, (2) `oldString` verbatim 복제 토큰. A(너그러운 매칭)는 (1)만 완화하고 (2)는 남김 + fuzzy
   오매칭 꼬리위험. B(모델이 해시 앵커 참조)는 둘 다 공격(토큰↓·애매함 제거)하나 *읽기뷰가 해시를
   emit → 모델이 앵커 참조 → 해시 적용* 풀루프여야 하고 **모델 의존적**(로컬/약한 모델은 앵커 헛짚음,
   [roadmap P3](./roadmap.md)). → **B를 주축, A를 폴백**으로 layer: capable 모델은 앵커로 B의 천장,
   앵커 없음/stale이면 hard-fail 대신 A 너그러운 매칭으로 바닥 보장. 착수는 단계 3에서 **A 폴백 먼저**
   깔아 전 모델 즉시 실패 감소 → 그 위에 B(해시뷰+앵커) 얹어 천장. 끝 상태는 하이브리드 1개.
5. ~~아티팩트 보안 범위~~ → **plugin:// 샌드박스 그대로 + tool/fs/http grant 0 + postMessage에 특권도구
   미노출**(§S.1). 아티팩트는 표시 전용, 망/도구 접근 없음.

**남은 결정:** 없음 — 구현 착수 가능.

---

## 부록 A — 출처

2세대 레퍼런스(2026-06 재확인):
- **Codex desktop app** — 병렬 thread/프로젝트 사이드바, Local/Worktree/Cloud, diff inline 코멘트,
  task sidebar 라이브, automations, 브라우저 요소 코멘트, 승인 "한 번/세션".
- **oh-my-pi** — Hashline(hash-anchored edits), ast-grep, 모델 4역할 라우팅, /review 병렬 reviewer P0~P3.
- **Claude Desktop** — 원클릭 MCP(.mcpb), Artifacts/Live Artifacts/MCP Apps.
- **pi / pi-gui** — 미니멀 코어 + 네이티브 셸(멀티 워크스페이스·persistent 세션 — 우리 보유).
- **openagent류** — 협업 멀티에이전트(비채택).

(URL은 채팅 리서치 로그 참조 — 문서에는 도구별 교훈만 박는다.)

---

### 부록 B — 결정 로그

- **2026-06-07:** v5 종료(G1~G5 + H1~H10 착지) 확인. v6 = 2세대 데스크톱 에이전트 벤치마크.
  두 축 = **W(미흡 보강)** + **G(가져오기)**, 잇는 축 = **U(UI/UX 흡수)**.
- **2026-06-07:** 코드 재감사 — "있지만 미흡" 9건(W1 edit brittle = P0 / W2 플러그인 설치 UI =
  stub / W3 메모리 발견성 …)을 file:line으로 채록. 가져올 능력 5건(G1 worktree / G2 병렬 thread /
  G3 automations / G4 아티팩트 / G5 역할 라우팅) 확정. UI/UX 흡수 10건(U1~U10) 매핑.
- **2026-06-07:** 차별점 후보 = U1(diff inline 코멘트) + U2(브라우저 요소 코멘트) — "런타임을 몰고
  검증한다" 테제와 정합. 협업 멀티에이전트·Cloud·컴퓨터 사용 = Non-goal.
- **2026-06-07 (리뷰 확정):** 범위 = **풀스코프**(병렬 thread/worktree/automations/아티팩트 v6 포함,
  큰 베팅은 단계 12에서 쪼갬). 순서 = **차별점 U1/U2 먼저** → W(신뢰) → 관리 UI → 큰 베팅. 리뷰 반영:
  에러복구/승인 단계 분리, 단계별 성공기준 추가, 모바일 패리티 명시, Hashline↔v5 G1 보완관계 명시.
- **2026-06-07 (보안 검토):** 기존 방어기제 코드 검증 — guardedFetch DNS-pin/SSRF·plugin:// 샌드박스
  (connect-src none)·CDP allowlist(Page.navigate 차단)·scrub·fs-safe 경계 **전부 견고 확인**(H9 등 사실).
  §S 신설: 신규 surface 위협→요건 매핑. P0 = U2(브라우저 DOM=untrusted 인젝션)·G4/U6(아티팩트 grant 0)·
  G3(automations 게이팅 풀바이패스 → 도구 allowlist+worktree 격리). 열린결정 5(아티팩트 보안) 해소.
- **2026-06-07:** 열린결정 4(Hashline 도입 방식) → **하이브리드(B 해시앵커 주축 + A 너그러운 매칭
  폴백)** 확정. 근거 = 근본 비용은 실패 재시도 루프 + verbatim 복제 토큰 둘 다이고, B만이 둘 다 공격하나
  모델 의존적이라 A를 바닥으로 깐다. 단계 3은 A 폴백 먼저 → B 얹기. **남은 열린 결정 없음 — 구현 착수 가능.**

---

## 구현 진행 (2026-06-07)

| 단계 | 항목 | 상태 | 커밋 |
|---|---|---|---|
| 1 | U1 diff inline 코멘트 | ✅ | `e6e5ea8` |
| 2 | U2 브라우저 요소 코멘트 (+§S.1 untrusted scrub) | ✅ | `435df99` |
| 3 | W1 Hashline **A-레이어**(너그러운 매칭) + harness 10케이스 | ✅ | `bed5d24` |
| 4 | W3 메모리 FTS 검색 + 자동 eviction | ✅ | `35cbba2` |
| 5 | W5/U4 에러복구 카드 | ✅ | `7b8ed98` |
| 6 | W7/U10 영속 allow + per-tool deny | ✅ | `dc901db` |
| 7 | W8 /review 병렬 reviewer P0~P3 | ✅ | `50ff8e3` |
| 8 | U5 steerable plan(step 토글/삭제) | ✅ | `d94eb28` |
| 10 | G5/U7 위임(subagent) 모델 라우팅 | ✅ | `3c51d90` |
| 9 | W6 MCP circuit-breaker 주기적 재연결 | ✅ | `3cac1d8` |
| 11 | G4/U6 인터랙티브 아티팩트(sandbox iframe, §S.1 grant-0) | ✅ | `153fbe8` |
| U9 | compaction 펼쳐보기 | ✅ 기존충족 | (CompactionDivider 이미 expandable + 원문은 스크롤백 유지) |
| 9-UI | 플러그인/MCP 관리 UI | ✅ 기존충족 | (PluginsSettings/McpServersSettings 이미 완비 — 감사 과장) |

**검증:** 각 단계 typecheck+build+lint 그린(무관한 기존 `Tour.tsx` lint 에러만 잔존). W1은
`harness:patch-match` 10/10, W6은 `harness:mcp` 145개 통과. 원격 환경 Electron 실행 불가 →
**UI 수동 점검 미실시**(로컬 `npm run dev` 권장).

**남은 작업 (대형 — 각각 별도 집중 라운드 필요):**
- **단계 12 — worktree → 병렬 thread → automations**: 세션→동시 thread 재설계 + git worktree 격리 +
  스케줄러. 대형 아키텍처(멀티 PR). worktree(기반)→thread(승격)→automations 순서로 쪼개야 하며,
  automations는 §S.1대로 worktree 격리 + per-automation 도구 allowlist가 전제(무인=auto 게이팅 우회).
  - **12-A 착지(엔진):** `electron/git-worktree.ts` — 로컬 git repo에 `marudesk/agent/*` 브랜치 worktree를
    add/list/remove, pending 변경 요약, base 브랜치로 머지(충돌 시 abort+worktree 보존, --force 금지)
    / discard. Source Control과 동일한 `runGit` 하드닝(argv-only·SSH 거부·C 로케일) 재사용. 실제 임시
    repo 대상 `harness:worktree` 24개 통과. **다음(12-B): 활성 root를 worktree로 스왑(에디터/에이전트/
    git 패널 일관) + 영속/UI를 thread 모델과 함께(앱 검증 필요).**
- **W1 B-레이어**: 읽기뷰 해시앵커(A 폴백은 착지). read_file 출력 포맷 변경이라 회귀 위험 큼 → 신중.
- **W4/U3**: subagent 라이브 스트리밍(main subagent-runtime → emit 채널).
- **W6 잔여**: trusted MCP 서버 per-tool 게이팅.
- **모바일 패리티**: U5 step-edit / U10 승인 토글(relay 커맨드 추가).
</content>
</invoke>
