# Agent 하네스 포팅 계획 — omo / gajae → marudesk

> 상태: **P0/P1 8개 티켓 전부 구현·검증 완료** (branch `feat/agent-port-edit1`, 2026-06-19; typecheck clean · `harness:all` 35/35 · `npm run build` ok) · P2는 §4 백로그로 등재
> 이 문서는 두 외부 코딩-에이전트 하네스를 전수 분석한 결과를 marudesk 실제 코드에 검증해 만든 **착수 가능한 구현 계획**이며, 아래 §구현 상태대로 P0/P1이 모두 이행됐다. 각 티켓은 현재 상태(file:line)·변경 단계·건드릴 파일·수용 기준·테스트 계획·리스크·확인 필요(open question)를 갖춘다.

## 구현 상태 (2026-06-19, branch `feat/agent-port-edit1`, 미커밋)

신규 소스 모듈 4개(`electron/agent/edit-span.ts`, `before-turn.ts`, `tools/normalize-schema.ts`, `tools/lsp-tools.ts`) + 신규 harness 6개. 20개 파일 수정(+1331/−130).

| 티켓 | 상태 | 검증 |
|---|---|---|
| EDIT-1 | ✅ core + follow-up (same-file collapse 버그 수정, line+hash, self-heal remaps, anchorLine schema/prompt wiring) | harness:patch-match 37/37 |
| HOOK-1 | ✅ before-turn 기여자 seam (empty registry, byte-identical) | harness:before-turn 10/10 |
| MCP-1 | ✅ stable tool sort + 500ms backoff + pending-dedup + DeferredMCPTool | harness:mcp (+17) |
| CACHE-1 | ✅ anthropic cache_control on the (stable) last tool | harness:cache-control 11/11 |
| COMPACT-2 | ✅ emergency floor (disabled/contextWindow-unknown에서도 발동) | harness:compaction-emergency 12/12 |
| COMPACT-1 | ✅ staleness-aware tool-output pruning | harness:compaction-prune 43/43 |
| PROV-1 | ✅ google + openai-strict 스키마 정규화 (fail-open, double-transform 회피) | harness:normalize-schema 36/36 |
| LSP-1 | ✅ definition/references/symbols/rename tools (rename은 gated applyEdits 경유) | harness:lsp-request-methods 15/15 |

후속 사소항목(각 티켓 ⏳ 참조): LSP hover 별도 tool·workspace-scope symbols, openai-compatible compat provider 스키마 정규화, EDIT-1 fs-level applyPatch e2e. P2 백로그는 §4.

## 2차 스윕 구현 상태 (2026-06-19, 같은 branch)

별도 2차 정밀 스윕(`C:/dev/marudesk-refscan/SECOND-PASS.md`)에서 net-new + 기존 개선 항목을 추가 발굴해 6개 배치로 전부 구현·검증. **누계(1·2차 합): 53 파일 수정(+3818/−252), 신규 파일 48개(소스 모듈 23 + harness ~20).** typecheck clean · `harness:all` 51/51 · `build` ok · `vitest` 427/427.

| 배치 | 구현됨 | 드롭/후속 (사유) |
|---|---|---|
| B1 edit 정확성 | BOM strip/restore, Unicode fold, indent-delta, 3-stage autocorrect, read-view prefix strip, **post-edit LSP diagnostic 인라인** | write-file guard(classifyOp가 이미 차단) |
| B2 compaction 안정 | **tool-pair orphan 복구(400 hard-fail 수정)**, preemptive 트리거, degradation monitor, file-op manifest, pruning micro-summary, incremental(merge) summary, per-tool output cap | token-ratio(미보정 근거 없음) |
| B3 loop 회복력 | **`withStreamRetry` 연결+Retry-After**, context-overflow 라우팅(overflow→compact, transient→retry), JSON-error 1-strike 리마인더, same-input loop detector, coerceToolResult 가드, per-step tool refresh | steering·ToolChoiceQueue(안전 producer 없으면 dead code) |
| B4 provider/usage | **per-model max-output-tokens**, model-id 정규화, Codex/Copilot/Gemini usage gauge, oneOf→anyOf compat, instruction dedup | adaptive-thinking(검증결과 버그 없음), append-only(이미 append-only), secret-obfuscation(불변식 위험) |
| B5 hooks/plugins | before/afterToolCall seam, plugin `ctx.exec`+`setStatus`, `onSession` 라이프사이클, sub-session 재개, delegation 리마인더, typed runtime snapshot, per-tool concurrency, glob-rule 엔진 | — (8/8, plugin 보안경계 보존) |
| B6 큰 net-new | HTML 세션 export, session handoff, `suggest_commit`(map-reduce), memory consolidation, line-snapshot relocate(보수적), TTSR 룰 매처(inert hook) | B6-5/6의 full 3-way merge·live mid-stream abort는 안전 민감 후속 |

추가로 loop.ts 기존 버그 수정: nested-instruction reminder 분기가 누적 `modelText`(output cap + nudge 반영) 대신 raw `out.text`를 써서 cap·loop-detector·delegation nudge를 버리던 것을 누적값 보존으로 교정.

## 0. 소스 · 스코프 · 산출 경위

**분석 대상 (전체 소스 스캔):**
- **omo** = [`code-yeongyu/oh-my-openagent`](https://github.com/code-yeongyu/oh-my-openagent) (npm `oh-my-opencode`). OpenCode 플러그인 + Codex CLI 사이드카 — **자체 모델 loop 없음**, 호스트 lifecycle hook slot에 주입. 37패키지 TS 모노레포.
- **gajae** = [`Yeachan-Heo/gajae-code`](https://github.com/Yeachan-Heo/gajae-code) (gjc). **자체 loop를 가진 독립형 하네스** (Bun/TS + Rust natives + Python 커널).

**산출 경위:** 18-에이전트 워크플로우가 두 레포(8,673파일)를 실제로 읽어 서브시스템별 구조화 findings를 만들고, marudesk 현재 아키텍처를 교차 매핑해 23개 추천을 도출 → 그중 P0/P1 8건을 9-에이전트 워크플로우가 marudesk 실제 코드에 grounding해 아래 티켓으로 확정. 클론 스냅샷은 `C:/dev/marudesk-refscan/{omo,gajae}` (스크래치). 전체 분석 리포트는 같은 위치 `PORTING-ANALYSIS.md`.

**이 문서의 용도:** §1–§5가 착수용 실행 계획이고, §A–§D는 그 근거가 되는 배경·갭·안티패턴이다. 구현은 §5(착수 제안)→해당 티켓 순으로 진행한다.

## A. 배경 — omo / gajae 아키텍처 차이

| | omo | gajae |
|---|---|---|
| 정체 | OpenCode 플러그인 / Codex 사이드카, **자체 loop 없음** | **자체 dual-loop 독립 하네스** (Bun+TS+Rust+Python) |
| 배울 것 | **구조 패턴** (hook seam, ContextCollector, hashline 검증 구조, MCP pool) | **개별 알고리즘** (compaction pruning, schema normalize, dual-loop, GoalRuntime) |
| 외피 충돌 | 적음 (in-process TS) | 큼 (Bun/tmux/Rust/SQLite/CLI → Electron엔 알맹이만 떼어 재작성) |

핵심: omo는 "남의 loop에 끼어드는 합성형 hook 레이어"라 *구조*가, gajae는 "모든 걸 직접 소유한 harness"라 *알고리즘*이 배울 가치가 크다. gajae의 Bun/tmux/Rust/SQLite/CLI 외피는 marudesk(단일 Electron, strict-TS, no-native-build)와 정면 충돌하므로 알맹이만 Electron-native로 옮긴다.

## B. marudesk 현재 상태 & 갭 (코드 검증 정정 포함)

**이미 갖춘 것 (재발명 금지):** hash-anchored 편집(`electron/agent/line-anchor.ts`, SHA-256 7-char), 계층형 시스템 프롬프트 + SAFETY_FOOTER(`loop.ts:277-314`), tail-preserve compaction(`loop-compaction.ts`), 성숙한 13-provider/auth 레이어(`model.ts`), **in-process LSP manager**(`electron/lsp/`, 진단 가동 중), ThreadContainer + `spawn_subagent` fan-out, skill single-gateway, isolated-worker 플러그인 런타임.

**grounding이 정정한 가정 (실제 코드 기준):**
- **LSP는 이미 존재·가동** — `electron/lsp/{client,manager,jsonrpc}.ts`에 진단까지 동작. 빠진 건 요청 메서드(definition/references/hover/rename)와 agent tool뿐. ("No LSP" 갭은 STALE.)
- **`multi_edit`는 같은 파일에서 atomic이 아님** — §C 참조 (확인된 데이터 손실 버그).
- **MCP list-changed 구독은 이미 구현됨** (`mcp-external.ts:659`).
- **`RECONNECT_BASE_MS`가 1000ms** (레퍼런스는 500ms) → 첫 두 reconnect window가 다름. MCP-1이 수정.
- **Google AI SDK가 tool 스키마를 이미 부분 변환** → PROV-1은 double-transform 회피를 위해 SDK 미처리분만 정규화.

**실제 갭:** stale anchor 자가치유 없음(MismatchError.remaps), 같은-파일 multi_edit 덮어쓰기(§C), compaction에 staleness pruning/emergency floor 없음, per-provider schema 정규화 없음, MCP deferred-tool/backoff/stable-sort 없음, prompt-cache breakpoint 미연결, LSP 요청 메서드/네비게이션 미구현.

## C. ⚠️ 확인된 버그 — same-file `multi_edit` 덮어쓰기 (데이터 손실)

**코드로 확인된 실제 버그** (EDIT-1이 함께 고침):

- `multiEdit`(`file-tools.ts:349-354`)는 입력 edits 배열을 독립 op 그대로 `applyEdits`에 넘기고, `applyEdits`는 전부를 한 번에 `applyPatch(ctx.ws, ops.map(toPatchOp))`(`file-tools.ts:314`)로 전달한다.
- `applyPatch` Phase 1(`patch.ts:255-301`): **각 edit op이 디스크 원본을 독립적으로 다시 읽고**(`readForPatch`, `patch.ts:280`) 각자 full-file 결과를 계산한다(`nextContent = content.slice(0,start) + newString + content.slice(end)`, `patch.ts:290-291`). 같은 파일 두 op은 **같은 원본**을 본다(Phase 3 전까진 디스크에 아무것도 안 써짐).
- Phase 3(`patch.ts:343-371`)는 tmp들을 **순차 rename**한다(`tmp1→file`, 이어서 `tmp2→file`). 결과 파일 = `nextContent2` = **op2만 반영, op1 편집은 조용히 소실**.

**트리거 조건:** 두 op이 원본에서 **각각 독립적으로 resolve**될 때(예: 한 파일의 서로 다른 두 함수를 동시에 수정 — 매우 흔한 multi_edit 사용). op2가 op1 결과에 의존하면 resolve 실패로 patch 전체가 에러(이 경우는 조용하지 않음). 즉 **흔한 "한 파일 여러 곳 수정" multi_edit에서 마지막 한 곳만 적용되고 나머지는 무경고 누락**된다.

**심각도:** 높음(무경고 데이터/편집 손실, 일상적으로 트리거). **수정:** EDIT-1 Step 6 — 같은-파일 op을 abs path별 **단일 plan으로 collapse**: 각 후속 op의 span을 직전 op의 `nextContent`에 **재-resolve**한 뒤 그 위에 적용해, abs당 plan(=tmp/rename) **하나만** Phase 2/3에 진입시킨다(마지막-쓰기-승리 race 제거). 이렇게 하면 rollback의 `originalContent`는 최초 디스크 값 그대로라 정확하고, descending 정렬은 정확성에 불필요하다(span 재-resolve가 위치 이동을 자동 처리). 이 데이터-손실은 코드로 확인됨(위 trace). EDIT-1 수용 기준에 2-op 회귀 테스트를 포함한다.

## D. 가져오지 말 것 (안티패턴)

- **SHA-256/7-char anchor를 omo xxhash32/2-char로 교체** — 이미 동작하는 anchor 무효화 + 충돌저항 약화. *validation/remap 구조만* 차용.
- **omo lsp-daemon (Unix-socket/named-pipe 사이드카)** — short-lived CLI용 cold-start 분할상환 장치. Electron main은 이미 long-lived → dead weight + 공격면. *in-process manager가 올바른 shape*.
- **Rust-native PTY / brush-core 영속 셸, Python runner.py 커널, DAP 세션, ast-grep 바이너리 다운로더, prebuilt 네이티브 바이너리** — no-native-build / no-CLI-process 제약 위반. `run_command` + 통합 터미널로 충분.
- **team mode / tmux mailbox** (omo team-core, gajae coordinator-mcp send-keys) — multi-process CLI 형태. marudesk는 ThreadContainer Map + `spawn_subagent`가 올바른 단일-프로세스 analog.
- **per-model-family prompt 분기** (omo 8개 Sisyphus prompt, gajae mechanics/principle split) — 10+ provider variant 유지는 maintenance bomb. capability-keyed `modelGuidance()`(provider당 ≤1문장)가 정답.
- **auth-broker SQLite vault, Claude Code plugin-DB compat, cryptographic completion-verification + transaction journal, 54-slot named-hook 프레임워크 전체** — 다중머신/다중writer/CC-clone 가정. 단일 Electron엔 과설계. per-turn `resolve-auth.ts`, 자체 isolated-worker runtime, plain-JSON 영속, 최소 before-turn seam(HOOK-1)이 올바른 altitude.

---

# 구현 백로그 (omo/gajae 포팅 P0 + P1)

## 1. 개요

이 백로그는 omo/gajae 레퍼런스 스냅샷에서 검증한 P0 1건(EDIT-1)과 P1 7건(HOOK-1, COMPACT-1, COMPACT-2, PROV-1, LSP-1, MCP-1, CACHE-1)을 marudesk에 이식하는 작업을 다룬다. 의존성 척추는 단 두 개뿐이다 — **CACHE-1 → MCP-1** (캐시 breakpoint가 안정적으로 적중하려면 tool 배열 순서가 안정 정렬되어야 함). 나머지 5건은 모두 `dependsOn: []`로 서로 독립적이므로 자유롭게 병렬·재배치 가능하다. 단, 가치·리스크 관점에서 EDIT-1을 먼저(편집 정확성 토대), HOOK-1을 둘째(여러 후속 주입 기능이 올라탈 seam)로 잡는 것을 강력 권고한다.

주의: 여러 spec이 brief의 가정을 정정했다 — LSP 서브시스템은 **이미 존재하며 가동 중**(요청 메서드와 agent tool만 누락), multi_edit는 brief가 말한 것처럼 "이미 atomic"하지 **않다**(같은 파일 다중-op는 두 번째가 첫 번째를 덮어씀), MCP list-changed 구독은 **이미 구현됨**. 아래 티켓은 실제 코드 상태를 반영한다.

---

## 2. 추천 실행 순서 (sequencing)

1. **EDIT-1** (P0 / M) — 편집 정확성의 토대. duplicate-line ambiguity와 같은-파일 다중-op 덮어쓰기는 실제 데이터 손실 버그다. LSP-1의 rename apply 경로가 `applyEdits`를 재사용하므로 그 가드/배치-검증이 먼저 단단해야 한다. **LSP-1 rename을 떠받친다.**
2. **HOOK-1** (P1 / S) — before-turn 기여자 seam. COMPACT-1 요약 preamble, PROV-1 live-validation note, LSP-1 진단 스냅샷 등 **여러 후속 기능이 올라탈 기반**. 작고(S) byte-identical 보장이라 회귀 위험이 거의 없으니 일찍 깔아두면 이후 주입이 ad-hoc 분기 대신 등록 한 줄로 끝난다.
3. **MCP-1** (P1 / M) — runtime-MCP 수명주기 강건화 + **stable tool-name 정렬**. CACHE-1의 전제. 정렬이 없으면 server 재연결 순서마다 tool 배열 바이트가 바뀌어 캐시가 깨진다. **CACHE-1을 unblock한다.**
4. **CACHE-1** (P1 / S) — Anthropic prompt-cache breakpoint. `dependsOn: [MCP-1]`. MCP-1 정렬 위에 올라타야 적중률이 최대화된다(MCP 없이도 correctness는 안전하나 hit-rate만 낮음). MCP-1 직후 가장 작은 비용으로 토큰/지연 이득.
5. **COMPACT-2** (P1 / S) — emergency compaction floor. 순수 로직 추가 한 건, 기존 turn-end 경로에만 붙음. 독립적이고 작아서 어느 시점에 넣어도 무방하나, 무한 성장 세션을 막는 안전망이라 일찍 확보할수록 좋다.
6. **COMPACT-1** (P1 / M) — staleness-aware tool-output pruning. HOOK-1과 직접 의존은 없으나, 요약 preamble을 before-turn seam으로 노출할 거면 HOOK-1 이후가 자연스럽다. 순수 함수 + vitest라 검증 비용 낮음.
7. **PROV-1** (P1 / M) — per-provider tool-schema 정규화. 독립적. Google double-transform 리스크 검증(Step 1)이 선행 게이트라 신중을 요함. EDIT-1/MCP-1처럼 즉각적 버그 수정은 아니고 멀티-프로바이더 견고성 강화라 후순위로 둔다.
8. **LSP-1** (P1 / M) — LSP 요청 메서드를 gated agent tool로. rename apply가 EDIT-1의 `applyEdits`(export 필요) 가드를 재사용하므로 **EDIT-1 이후**가 이상적. 가장 표면적이 넓고(7개 파일 + 2 신규) open question이 많아 마지막 큰 슬라이스로 적합.

요점: **EDIT-1이 LSP-1 rename을 떠받치고, HOOK-1이 여러 후속 주입 기능의 토대이며, MCP-1 stable 정렬이 CACHE-1과 짝을 이룬다.**

---

## 3. 구현 항목 (티켓)

### EDIT-1 — Hashline anchor 업그레이드: line+hash resolver, MismatchError.remaps, batch-validate, same-file op collapse
- **priority/effort/approach**: P0 / M / borrow-idea
- **구현 상태 (2026-06-19, branch `feat/agent-port-edit1`)**: ✅ Step 1-3(`anchorLine`/`endAnchorLine` 필드 + `resolveByLineAndHash` + `resolveEditSpan` 분기), ✅ Step 6(같은-파일 op collapse — §C 데이터-손실 버그 수정; 순수 코어를 신규 `electron/agent/edit-span.ts`로 분리, `applyPatch`는 abs별 단일 plan으로 호출), ✅ Step 7/9/10(`file-tools.ts` 전파 + harness 11 케이스 추가, typecheck clean, harness:all 29/29). ⏳ **남은 작업(후속)**: Step 4-5(`AnchorMismatchError.remaps` + `batchValidateAnchors` self-heal)과 모델이 `anchorLine`을 실제로 보내도록 하는 tool 스키마/프롬프트 wiring(아래 open question), 그리고 선택적 fs-level `applyPatch` e2e 테스트.
- **현재 상태**:
  - `marudesk/electron/agent/line-anchor.ts:40-61` `locateAnchorLine`은 전체 파일 스캔으로 유일성 판정 → 동일 내용 두 줄은 `{ ok:false, reason:'ambiguous' }`로 편집 자체가 막힘. line-number 힌트 없음. ANCHOR_LEN=7 hex(SHA-256).
  - `marudesk/electron/patch.ts:245-381` `applyPatch`는 op를 공급 순서대로 처리(L255), descending-line 정렬 없음. 같은 파일 다중-op는 각 op가 `readForPatch`로 원본 바이트를 독립 재읽기 → Phase 3에서 두 번째 rename이 첫 번째 결과를 **조용히 덮어씀**.
  - `marudesk/electron/agent/tools/file-tools.ts:281-312` 스테일 가드는 **첫 스테일에서 즉시 return** → 다중-파일 multi_edit는 재시도당 오류 1건.
  - `MismatchError` 클래스 없음. 스테일 감지는 read-tracker.ts의 전체파일 SHA-256뿐, 구조화된 `.remaps` 없음.
  - `text-window.ts:67-71` 읽기 뷰는 이미 `N <hash>\t` prefix를 노출하나, line number는 `anchor` 필드에 인코딩되지 않음(모델이 7-char hash만 저장).
  - **정정(코드 확인)**: brief는 "multi_edit는 이미 atomic"이라 했으나 실제로는 같은-파일 다중-op가 §C의 덮어쓰기 버그를 가짐. 또한 brief의 "descending 정렬"은 정확성 불변식이 **아니다** — 각 op이 full-file 치환을 계산하므로 올바른 전환은 abs당 op을 단일 plan으로 collapse하며 후속 op의 span을 누적 `nextContent`에 재-resolve하는 것(§C 수정 참조).
- **변경 단계**:
  1. `shared/patch.ts` PatchOp에 `anchorLine?: number`(+`endAnchorLine?:number`) 추가, `isPatchOp`가 양의 정수/undefined 허용.
  2. `line-anchor.ts`에 `resolveByLineAndHash(content, lineNo, anchor)` 추가 — `lines[lineNo-1]` 먼저 검사, 불일치 시 `locateAnchorLine` 스캔으로 fallback. duplicate-line ambiguity 해소.
  3. `patch.ts` `resolveEditSpan`에서 `anchorLine` 존재 시 `resolveByLineAndHash` 호출, 없으면 기존 경로(endAnchor 동일).
  4. `AnchorMismatch` 타입 + `AnchorMismatchError extends Error`(`readonly remaps: ReadonlyMap<string,string>`) 정의(main-process 전용, shared 금지 — node:crypto 의존). read-tracker 전체파일 가드에는 remaps 추가 금지(다른 레이어).
  5. `batchValidateAnchors` 선행 패스 추가 — 모든 op의 anchor를 unique path당 1회 읽기로 검사, **모든** mismatch 수집, 있으면 `AnchorMismatchError` throw. `applyEdits`에서 catch → 영향 파일 `recordRead` 갱신 → 모든 스테일 anchor+remap을 담은 단일 ToolResult 오류 반환.
  6. **같은-파일 다중-op collapse (§C 버그 수정)** — Phase 1에서 `Map<abs, Plan>` 유지. 어떤 abs의 첫 op은 현행대로 disk를 읽어 plan 생성(`originalContent = diskContent`). 같은 abs의 후속 op은 disk를 다시 읽지 말고 `resolveEditSpan(priorPlan.nextContent, op)`로 span을 **재-resolve**해 `nextContent`를 직전 plan의 `nextContent` 위에서 재계산하고 그 abs의 plan을 **교체**(`originalContent`는 최초 disk 값 유지)한다. 따라서 abs당 plan(=tmp/rename) **하나만** Phase 2/3에 진입 → 마지막-쓰기-승리 race 제거 + rollback 정확성 보존. 정렬 불필요. 후속 op의 span이 누적 content에서 not-found면(겹치는 편집) 기존 오류 경로로 안전 실패. 다른 파일 op는 불변.
  7. `file-tools.ts` `EditOp`/`isOp`/`toPatchOp`에 `anchorLine`/`endAnchorLine` 전파.
  8. `text-window.ts` `pageLines` — display 무변경(NO-OP), 주석으로 "표시된 line number를 anchorLine으로 전달" 문서화.
  9. `patch-match.harness.ts` 케이스 추가(아래 테스트 계획).
  10. `npm run typecheck` + `harness:patch-match` + `harness:all`.
- **건드릴 파일**: `shared/patch.ts`, `electron/agent/line-anchor.ts`, `electron/patch.ts`, `electron/agent/tools/file-tools.ts`, `electron/patch-match.harness.ts` (신규 파일 없음; AnchorMismatchError를 별 파일로 빼면 `electron/agent/anchor-error.ts` 선택)
- **수용 기준**:
  - lineNo=1/2 공급 시 동일 두 줄의 첫/두 번째를 각각 해소(현재 ambiguous).
  - lineNo가 틀려도 hash가 유일하면 스캔 fallback 성공.
  - anchor가 스테일이면 lineNo가 맞아도 not-found.
  - op 1·3이 스테일인 3-op multi_edit가 **단일** AnchorMismatchError(세 anchor + fresh 교체값)로 반환.
  - `remaps`가 stale→fresh hash Map.
  - 같은 파일 line 10·50 두 anchored op가 **둘 다** 반영.
  - `typecheck`/`harness:patch-match`/`harness:all` 모두 exit 0.
- **테스트 계획**: `electron/patch-match.harness.ts`(`harness:patch-match`)에 Block 1(line-hint 해소/fallback/stale), Block 2(batch-validate 수집/remaps/all-current), Block 3(같은-파일 2·3-op collapse: 모든 편집 반영·op 순서 무관, rollback `originalContent`=최초 disk, 겹치는 span은 안전 오류). 부차: `typecheck`, `harness:all`.
- **의존성**: 없음
- **리스크**:
  - **span 재-resolve 필수**: 후속 same-file op의 char offset은 직전 `nextContent`에 대해 다시 계산해야 함 — 원본 기준 offset 재사용 금지(op1이 길이를 바꾸면 어긋남). collapse가 abs당 plan 하나만 남기므로 Phase 3 rollback의 `originalContent`는 최초 disk 값 그대로라 정확(중간 상태 보관 불필요).
  - collapse는 Phase 1에서만 — Phase 2/3(tmp write/rename sweep)는 무변경. "abs당 단일 plan" 불변식을 harness로 고정.
  - `AnchorMismatchError`는 신규 throw. `applyPatch`는 throw 안 하고 `ApplyResult` 반환하므로 `applyEdits`에서 catch(기존 스테일 가드 패턴과 일치)가 선호 경로.
  - `anchorLine`은 renderer 번들 가시 shared 변경이나 optional + isPatchOp 조건부 검증이라 additive·안전(renderer는 PatchOp 직접 생성 안 함).
- **확인 필요**:
  - `anchorLine`을 anchor 문자열에 임베드(`42:a3f9b12`)할지 별도 필드로 둘지(별도 필드=최소 변경, 단일 필드=omo/gajae 관례). Step 1 전 결정 — text-window 표시 형식까지 cascade.
  - 모델이 `anchorLine`을 채우게 하려면 tool 스키마/프롬프트 문서화 vs prefix 추론 의존(프롬프트 엔지니어링, 이 슬라이스 범위 밖이나 프로덕션 가동 전 답 필요).
  - mismatch 시 `recordRead` 재기록이 진짜 스테일 상황을 가리지 않는지 확인.
  - 같은-파일 다중-op 버그 → **코드로 확인 완료(§C)**; EDIT-1이 함께 수정. 2-op 회귀 테스트로 수정 검증.

---

### HOOK-1 — Before-turn 기여자 seam (priority-ordered, consume-once)
- **priority/effort/approach**: P1 / S / borrow-idea
- **현재 상태**:
  - 시스템 프롬프트 조립은 `loop.ts:277-327` `activate()` 클로저 — `baseSystem`, `modelGuidance`, `envContext`, `modeContext`, `wsInstructions`, `globalUserInstructions`, `opts.customInstructions`, `planAddendum`, `trustFooter` 9슬롯을 `\n\n---\n\n`(L313)로 join. env/ws/global은 loop 전 `Promise.all`(L260-264)로 1회 resolve.
  - per-turn user-text는 `startTurn()`(L966-1132)에서 `buildUserText` + `runContextHook` `<context>` 블록.
  - **확장 seam 전무** — 기여자 리스트/register-unregister/priority 메커니즘 없음. 새 first-party 주입은 ad-hoc 인자나 in-function 분기로 wiring해야 함.
- **변경 단계**:
  1. `electron/agent/before-turn.ts` 신규(Electron import 없는 순수 모듈). `BeforeTurnMeta`(readonly: ws/approvalMode/provider/modelId/customInstructions), `BeforeTurnPriority`('critical'|'high'|'normal'|'low') + `PRIORITY_ORDER`, `BeforeTurnContributor = (meta)=>Promise<string|null|undefined>`. `registerBeforeTurnContributor(priority, fn): ()=>void`(module-level 배열 push, splice cleanup 반환), `runBeforeTurnContributors(meta): Promise<string[]>`(priority→order 정렬, serial 실행, try/catch 각각 비치명적, non-empty 수집).
  2. `loop.ts`에서 import. `activate()` 인자 객체에 `contributorAddenda: string[] = []` 추가, join 배열에서 `opts.customInstructions` 뒤·`planAddendum` 앞에 splice(숫자 인덱스 대신 이 두 슬롯 사이로 명시 — trust 순서 보존). 기존 join이 falsy 필터하므로 빈 문자열 자동 drop.
  3. `startTurn()`에서 `Promise.all`(L260) 후·`activate()`(L329) 전에 `const contributorAddenda = await runBeforeTurnContributors({...})` 호출, 초기 `activate(...)`에 전달. `pickNextFallback()`(L347-366)은 같은 스코프 클로저로 자연 캡처(option a).
  4. **v1에서는 기존 9슬롯 레이어를 built-in 기여자로 재등록하지 않음** — byte-identical 보장 위해 그대로 둠. 기여자 배열은 빈 상태로 시작.
  5. `registerBeforeTurnContributor`를 `loop.ts`에서 re-export(외부 caller가 내부 모듈 직접 import 없이 등록).
  6. `before-turn.harness.ts` + `harness:before-turn` 스크립트(순수, `--experimental-strip-types`, MCP register 불필요).
- **건드릴 파일**: `electron/agent/loop.ts`, `package.json` / **신규**: `electron/agent/before-turn.ts`, `electron/agent/before-turn.harness.ts`
- **수용 기준**:
  - 기여자 0개 시 조립된 시스템 프롬프트가 현재와 **byte-for-byte 동일**.
  - 등록 순서 무관하게 critical→normal→low 순 실행.
  - null/undefined 반환 기여자는 무기여.
  - throw 기여자가 turn을 중단시키지 않음(오류 swallow, 나머지 실행).
  - unregister가 이후 호출에서 기여자 제거.
  - `typecheck`/`harness:before-turn` exit 0, `harness:all` auto-discover.
- **테스트 계획**: `harness:before-turn` — empty registry, null 제외, priority 순서(역순 등록), unregister, throw skip, same-priority registration-order. 부차: `typecheck`. e2e 불필요(empty registry byte-identity는 코드 인스펙션+typecheck로 확인).
- **의존성**: 없음
- **리스크**:
  - `activate()`는 `runLoop()` 내부 클로저 — `let contributorAddenda: string[]=[]`를 클로저 전 선언 후 첫 호출 전 1회 set(option a). pickNextFallback도 같은 outer 스코프 캡처.
  - `runBeforeTurnContributors`가 activate 전 await되어 startTurn 지연 추가(기여자 0개 시 무시 가능). 느린 기여자는 후속 iteration에서 timeout 가드.
  - before-turn.ts의 module-level 상태는 process-global(Electron 단일 main에 적합). 대화 reset/thread 전환 가로질러 persist — v1 의도(first-party 장수 등록)이나 per-turn/per-thread 격리 가정 금지로 spec에 명시.
- **확인 필요**:
  - splice 위치를 `opts.customInstructions` 뒤(슬롯 8, planAddendum 앞)로 — user standing instructions를 mode 직전 마지막으로 유지하는 안전 기본값. 코딩 전 확정.
  - before-turn.ts가 dependency-free 유지(shared/workspace.ts·settings.ts에 top-level side-effecting Electron import 없는지 확인).
  - `runBeforeTurnContributors`를 before-turn.ts에서 직접 export(harness용) + loop.ts re-export(프로덕션)할지.

---

### COMPACT-1 — Staleness-aware tool-output pruning (요약 전)
- **priority/effort/approach**: P1 / M / borrow-idea
- **현재 상태**:
  - `loop-compaction.ts:54-56`이 `splitForTailPreservation` 후 `head`를 그대로 `serializeForCompaction(head)`(compaction-utils.ts:44)로 전달. split↔serialize 사이 **staleness pruning 없음**. head는 full tool-result payload(원본 `output.value` 전체가 토큰 무게원)를 포함.
  - AI SDK tool result ModelMessage: `{ role:'tool', content:[{ type:'tool-result', toolCallId, toolName, output:{ type:'text'|'error-text'|'content', value } }] }`(loop-helpers.ts:18-35, loop.ts:758). 선행 assistant turn은 `tool-call`(loop.ts:493).
  - `read-tracker.ts`는 read-before-edit 가드용 path별 SHA-256일 뿐, compaction용 read-history index 없음.
  - 레퍼런스 `buildStalenessIndex`(pruning.ts:284-363)는 gajae `SessionEntry[]` 타입 기반 — marudesk `ModelMessage[]`로 **재표현** 필요.
- **변경 단계**:
  1. `compaction-utils.ts`에 순수 `pruneStaleToolOutputsInHead(head: ModelMessage[]): { prunedCount; charsSaved }` 추가(in-place 변형 + stats 반환).
  2. 2-pass staleness index — Pass1: `callsByCallId` 수집(assistant `tool-call`). Pass2: `tool-result` 순회, `toolTargetKey`(`read_file`→`[name,'path',path]`, `grep`→`[name,'pattern',pattern]`) 계산, `lastResultIdxByKey`/`lastEditIdxByPath` 유지. edit 추적: `edit_file`/`multi_edit`(input.path/file_path). `output.type==='error-text'`는 isError → 추적/등록 skip. stale = 더 늦은 same-target result로 superseded **또는** read_file이 이후 edit된 경우.
  3. Prune 패스: 끝에서 역방향, `accChars` 유지. `['read_file','grep','run_diagnostics']` 단일 result만 후보. protect window(`accChars < PRUNE_PROTECT_CHARS` && **not stale**) skip(stale은 window 안이라도 prunable). 이미 짧은 것(≤PRUNE_DIGEST_CHARS) skip.
  4. Hysteresis: `totalCharsSaved < PRUNE_MIN_SAVINGS_CHARS`면 no-op. 상수: `PRUNE_PROTECT_CHARS=8000`, `PRUNE_MIN_SAVINGS_CHARS=4000`, `PRUNE_DIGEST_CHARS=120`.
  5. 교체: `output`을 `{ type:'text', value:'[pruned — ~N chars freed]' }`로. toolName/toolCallId/role 보존(쌍 무결성).
  6. `loop-compaction.ts`에서 `splitForTailPreservation`(L54) 직후·`serializeForCompaction`(L56) 직전 무조건 호출.
  7. `prunedCount>0`이면 `console.debug` 로그(UI 변경 불필요).
  8. export.
  9. `compaction-utils.test.ts`(vitest)에 9 케이스 describe 추가.
- **건드릴 파일**: `electron/agent/compaction-utils.ts`, `electron/agent/loop-compaction.ts`, `electron/agent/compaction-utils.test.ts` (신규 없음)
- **수용 기준**:
  - 임계 미만 시 `{ prunedCount:0, charsSaved:0 }`.
  - 재읽힌 read_file/이후 edit된 read_file은 prune notice로 교체(role/toolCallId/toolName 불변).
  - path별 **최신** read_file은 prune 안 됨.
  - protect window 안: stale이면 prune, non-stale이면 불변.
  - error-text edit result는 edit 등록 안 함(선행 read 무효화 안 함).
  - head 밖 메시지 불변.
  - `typecheck` 통과, 기존 + 신규 vitest 통과.
- **테스트 계획**: `npx vitest run electron/agent/compaction-utils.test.ts` — 9 케이스(no-op, superseded read, edit-invalidates-read, protect-latest, grep superseded, run_diagnostics outside-window, stale-inside-window pruned, error-result not-tracked, tail 불변). 부차: `typecheck`. 통합 스모크: 긴 대화 `/compact` 후 divider/요약 일관성, main-process DevTools에서 debug 로그 관찰.
- **의존성**: 없음
- **리스크**:
  - 구조 불변식(every tool-call ↔ paired tool-result): output value만 교체하므로 보존 — 테스트로 명시 검증.
  - role `tool`은 multi-part 가능(병렬 호출). 메시지 전체가 아닌 **개별 part** prune — Step 3가 part 순회.
  - gajae의 `prunedAt` 가드 없음 → 이중 compaction 시 이미-pruned notice 재시도 가능하나 short-skip + hysteresis가 방어 — 테스트로 검증.
  - `readBasePath`(selector stripping) 불필요(read_file은 `:line` selector 미지원).
  - multi-part 인덱싱은 per-PART((msgIdx, partIdx) 또는 flat linear).
- **확인 필요**:
  - multi-part 인덱싱: (msgIdx, partIdx) vs flat — 레퍼런스가 flat entry 배열이라 flat이 더 부합.
  - freed char 추정 반올림(~4200) vs 정확.
  - run_diagnostics 포함 여부 — COMPACT_INSTRUCTION이 "error signature verbatim 보존"을 요구 → 초기 슬라이스는 read_file/grep만으로 한정, run_diagnostics는 opt-in 후속.
  - `compactConversation`이 유일한 compaction 진입점인지(auto-compact 포함) grep 확인.

---

### COMPACT-2 — 80% 토큰 임계 아래의 emergency compaction floor
- **priority/effort/approach**: P1 / S / borrow-idea
- **현재 상태**:
  - `loop.ts:943-954` `shouldAutoCompact`에 두 hard early-return — L946 `if (!cfg.enabled) return false`(비활성 시 무조건 off, emergency 경로 없음), L949-952 `MODELS.find(...)?.contextWindow`가 미등록 provider/custom/openai-compat에서 `undefined` → 무조건 false(무한 성장 가능).
  - 전체 codebase의 유일 compaction 경로(L938)가 이 함수로 gating. 보조 emergency 체크 없음.
  - `S.transcript.length`, `messageChars`(compaction-utils.ts:78-87) 가용. emergency 타입/상수/헬퍼 전무.
- **변경 단계**:
  1. `compaction-utils.ts`에 export: `EMERGENCY_MESSAGE_COUNT=500`, `EMERGENCY_TRANSCRIPT_CHARS=4_000_000`, `emergencyCompactionReason(transcriptLength, transcriptChars): 'messageCount'|'transcriptChars'|null`(순수, process 참조 없음).
  2. `loop.ts`에서 import. `shouldEmergencyCompact(S): boolean` — `transcriptChars = S.transcript.reduce((n,m)=>n+messageChars(m),0)`, `emergencyCompactionReason(...)!==null`. `!cfg.enabled` 체크 **전** 호출(비활성화 불가 floor).
  3. `shouldAutoCompact`를 `if (shouldEmergencyCompact(S)) return true;` 후 기존 로직으로 수정.
  4. 호출 지점(L938) 무변경.
  5. `compaction-emergency.harness.ts` 신규(harness-kit + compaction-utils, Electron stub 불필요): below-both→null, length 경계(=500 null, +1 messageCount), char 경계, 둘 초과 시 messageCount 우선.
  6. `harness:compaction-emergency` 스크립트 추가(auto-discover).
- **건드릴 파일**: `electron/agent/compaction-utils.ts`, `electron/agent/loop.ts`, `package.json` / **신규**: `electron/agent/compaction-emergency.harness.ts`
- **수용 기준**:
  - 둘 다 임계 이하 → null; length>500 → 'messageCount'; chars>4M & count<500 → 'transcriptChars'.
  - 어느 floor 초과 시 `cfg.enabled=false`라도 `shouldAutoCompact` true.
  - 모델 미등록(contextWindow undefined)이라도 floor 초과 시 true.
  - 정상 token-ratio 경로 불변(enabled=false & floor 미초과 시 false).
  - `harness:compaction-emergency`/`harness:all`/`typecheck` 통과.
- **테스트 계획**: 신규 harness 4 경계 케이스. 부차 `typecheck`. e2e 불필요(기존 turn-end 경로 순수-로직 추가).
- **의존성**: 없음
- **리스크**:
  - `EMERGENCY_MESSAGE_COUNT=500`은 추정치. 무거운 agentic 세션은 tool_use+tool_result 쌍으로 더 일찍 도달 가능 — 300 또는 1000 대안 검토(실 세션 데이터로 확정).
  - `4_000_000`은 4 bytes/token 휴리스틱 기반, 의도적으로 매우 높아 false positive 회피(작은 context window는 token-ratio가 먼저 발동).
  - emergency도 기존 `compactConversation` 호출 → `loop-compaction.ts:35`의 `transcript.length<2` 가드로 신규 대화는 여전히 no-op(정상).
- **확인 필요**:
  - 무거운 agentic 세션의 현실적 max ModelMessage 수(레퍼런스 4000; 500은 multi-step 코딩에 빠듯할 수 있음).
  - emergency 경로를 사용자에게 surface(별도 divider 라벨)할지 — 후속 UI 질문, 블로커 아님.
  - `transcript.length<2` 가드 우회 필요 여부 — 실무상 불필요하나 단일 거대 메시지가 char ceiling을 먼저 치는 edge 확인.

---

### PROV-1 — streamText 전 per-provider tool-schema 정규화
- **priority/effort/approach**: P1 / M / borrow-idea
- **현재 상태**:
  - `model.ts` `aiTools()`(L433-443)가 provider 무관하게 모든 tool에 `jsonSchema(t.inputSchema as JSONSchema7)` 그대로 호출. per-provider 정규화 전무.
  - `loop.ts:254` `tools = aiTools(listMcpTools())` turn당 1회, provider별 변경 없음.
  - `@ai-sdk/openai`(v6.0.193)는 inputSchema verbatim 전달. `@ai-sdk/google`는 `convertJSONSchemaToOpenAPISchema`로 부분 변환(type-array→nullable, anyOf null-unwrap)하나 format/pattern/min*/max*/examples/$ref/$defs/prefixItems 등을 description으로 lift 없이 **조용히 drop**, snake_case rename/const→enum/propertyOrdering 미처리. openai-strict 강제(additionalProperties:false, all-required, oneOf→anyOf) 어디에도 없음.
  - **정정**: brief의 WeakMap node cache + epoch guard는 레퍼런스 walker용. 최소 슬라이스는 `normalizeSchemaForGoogle`과 `sanitizeSchemaForOpenAIResponses`/`enforceStrictSchema`의 end-user 함수 + 직접 의존만 vendor, 전체 stamp 인프라는 제외.
- **변경 단계**:
  1. **선행 검증**: `@ai-sdk/google/dist/index.js:304-400`와 `@ai-sdk/openai/dist/index.js:604-622` 읽어 — (a) Google SDK가 자체 부분 변환하므로 `normalizeSchemaForGoogle`은 SDK **전**에 실행, anyOf null-unwrap/type-array는 **재구현 금지**(double-transform). (b) OpenAI는 verbatim, double-transform 없음. 인라인 주석으로 분석 기록. (dist 줄번호는 minified라 버전마다 이동 — 설치된 `@ai-sdk/google`/`@ai-sdk/openai` 버전을 기준으로 재확인하고 package.json/lock으로 버전 고정 후 줄번호 갱신.)
  2. `electron/agent/tools/normalize-schema.ts` 신규(순수 TS, Electron/logger/외부 import 없음): 로컬 `UNSUPPORTED_SCHEMA_FIELDS`(fields.ts:16-39 복사) + `NON_STRUCTURAL_SCHEMA_KEYS`, `JsonObject`/`isJsonObject`, `normalizeSchemaForGoogle`(SDK 미처리분만 — snake_case rename, UNSUPPORTED strip+description lift, type:null→nullable, propertyOrdering, ensureObjectProperties), `normalizeSchemaForOpenAIStrict`(WeakMap+Set cycle guard, fail-open), top-level `normalizeToolSchema(provider, schema)` dispatch(google/google-caa/google-vertex→Google; openai→strict[anyOf/oneOf/nullable/type-array 있을 때만]; openai-codex/xai→Responses; 그 외 pass-through).
  3. fail-open wrapper — 각 normalizer try/catch, 예외 시 `console.warn('[schema-normalize] …')` + 원본 반환(throw 전파 금지).
  4. `model.ts` `aiTools(schemas, provider?)` — `jsonSchema()` 전 `normalizeToolSchema(provider, t.inputSchema)`.
  5. 모든 call site 갱신 — `loop.ts:254` → `aiTools(listMcpTools(), opts.provider)`. `grep -rn 'aiTools(' marudesk/electron/`로 나머지 찾아 갱신(harness는 undefined → pass-through).
  6. strict tsconfig 준수(any/suppression/broad cast 금지). `ProviderId`는 `../../shared/providers`.
  7. `normalize-schema-harness.ts` 신규(`--experimental-strip-types`): Google strip/rename, OpenAI strict wrap, Responses oneOf→anyOf, unknown pass-through, fail-open, anthropic identity.
  8. `typecheck` + `harness:all`.
- **건드릴 파일**: `electron/agent/model.ts`, `electron/agent/loop.ts`, `electron/agent/tools/schema-helpers.ts`(무변경) / **신규**: `electron/agent/tools/normalize-schema.ts`, `electron/agent/normalize-schema-harness.ts`
- **수용 기준**:
  - google: 비지원 필드 strip + liftable description lift, snake_case→camelCase, 2+ prop에 propertyOrdering.
  - openai: optional prop을 `anyOf:[T,{type:'null'}]`로, 모든 object에 `additionalProperties:false`, oneOf→anyOf.
  - xai/openai-codex: oneOf→anyOf, object에 properties 보장.
  - anthropic/mistral: 원본 그대로(identity).
  - 오류 시 console.warn + 원본 반환, turn 지속.
  - `typecheck`/`harness:all` 통과, normalize-schema.ts에 any/suppression/broad cast 없음.
- **테스트 계획**: 신규 harness — Google(type-array/snake_case/unsupported strip, type:null→nullable, propertyOrdering, pass-through), OpenAI(additionalProperties/anyOf wrap/required-all, oneOf→anyOf, nested), xai(oneOf→anyOf, empty properties), Anthropic(strict identity), fail-open(circular ref). `harness:all` + `typecheck`.
- **의존성**: 없음
- **리스크**:
  - **Google double-transform**: SDK가 type-array→anyOf, anyOf null-unwrap을 이미 수행 → 중복 시 잘못된 출력. 정확히 SDK 네이티브 처리 필드를 확인·skip. 실 SDK 함수로 round-trip 단위 테스트 권장.
  - **OpenAI strict는 per-tool opt-in**(wire의 `tool.strict`). aiTools가 strict를 set하지 않으므로 `enforceStrictSchema` 적용은 구조 정리일 뿐 strict 모드 활성화 아님(additionalProperties/required-all은 backward-compatible). 이 spec은 strict:true 설정 안 함.
  - `enforceStrictSchema`는 표현 불가 스키마에 throw → fail-open이 안전망이나 일부 tool은 원본으로 revert. tool name/provider 로그로 운영자가 수정 가능하게.
- **확인 필요**:
  - Google `convertJSONSchemaToOpenAPISchema`가 doStream/doGenerate 전/후 실행되는지(검증됨: doStream tool-preparation 시점 → 우리 정규화는 jsonSchema() 전이 올바름).
  - openai-compatible compat(groq/mistral/deepseek/together/fireworks/cerebras)에 정규화 적용 여부 — 첫 슬라이스는 전부 skip, 거부 알려진 provider만 후속 플래그.
  - google-vertex 포함(model.ts:322-327상 같은 SDK → 포함이 맞음).
  - github-copilot Claude-dialect 경로 → pass-through 정답, copilot openai-compat은 defer.

---

### LSP-1 — LSP 요청 메서드를 gated agent tool로 (definition/references/hover/rename/symbols)
- **priority/effort/approach**: P1 / M / borrow-idea
- **현재 상태**:
  - **LSP 서브시스템은 이미 존재·가동**(brief의 "No-LSP gap STALE" 확인됨 — 요청 메서드와 agent tool만 누락). `lsp/jsonrpc.ts:57` sendRequest, `lsp/client.ts:53` LspClient(start()는 L84-95에서 onNotification/onRequest 핸들러+initialize, 아웃바운드 notification didOpen/didChange/didClose/openFiles는 L130-156, **request 메서드는 initialize 외 없음**), `lsp/manager.ts:167` syncFromContext/L230 disposeAllLsp.
  - manager의 module-level `clients` Map(`${root}::${serverId}`, L35), **getClientForFile류 export 없음** → agent tool이 LspClient에 도달 불가.
  - initialize capabilities(client.ts:107-115)는 synchronization + publishDiagnostics + workspaceFolders/configuration만. definition/references/hover/rename/documentSymbol 미선언.
  - agent tool 레이어에 LSP tool 전무. `file-tools.ts:247-337` `applyEdits`가 edit gate(SECRET_FILE, denyGlobs, staleness, applyPatch) — rename WorkspaceEdit의 per-file TextEdit[]가 multi_edit op로 자연 매핑, **이 경로 재사용이 필수**.
- **변경 단계**:
  1. `client.ts` initializeParams capabilities 확장 — definition/references/documentSymbol(hierarchicalDocumentSymbolSupport:true)/rename(prepareSupport:true)/hover(plaintext+markdown).
  2. LspClient에 5 메서드 추가(didClose 뒤 L152): definition/references/hover/prepareRename/rename/documentSymbols. 각 `sendRequest`, `{ textDocument:{uri}, position:{ line:line-1, character:character-1 } }`(1-based→0-based). `if (!this.conn||!this.ready) throw`. hover/prepareRename 10s, 나머지 20s 타임아웃.
  3. `manager.ts`에서 `getReadyClientsForFile(root, file): LspClient[]` export — `entry.root===root && entry.status==='ready' && entry.spec.extensions.includes(extOf(file))` 필터.
  4. `electron/agent/tools/lsp-tools.ts` 신규 — `lspNavigate`/`lspSymbols`/`lspRename`. `getReadyClientsForFile`, node:path/url, `SECRET_FILE_PATTERN`, `globToRegExp`, **`applyEdits`(file-tools.ts에서 export 필요)** import.
     - 4a `lspNavigate`: file/line/character + kind('definition'|'references'), ws 검증, client 조회, location을 `relPath:line:column`로(references cap 50, definition 10).
     - 4b `lspSymbols`: documentSymbols 트리 재귀 포맷(cap 200), SymbolInfo flat fallback.
     - 4c `lspRename`: prepareRename 먼저(null/`defaultBehavior:false`면 error), rename, WorkspaceEdit의 changes/documentChanges에서 파일 추출. 각 파일 read → bottom-up 정렬 → range에서 oldString 추출 → EditOp → `applyEdits(ops, ctx, 'lsp_rename')`(SECRET_FILE+denyGlobs+staleness+applyPatch). ToolResult verbatim 반환.
  5. `schemas.ts`에 lsp_navigate/lsp_symbols/lsp_rename ToolSchema 추가(strProp/intProp/boolProp).
  6. `executors.ts` EXECUTORS 등록 + describeToolInput.
  7. `registry.ts`: TOOL_GROUP(전부 'files'), WORKSPACE_TOOL_NAMES; lsp_rename을 WRITE_TOOL_NAMES + `types.ts` GATED_TOOLS(L109). navigate/symbols는 ungated.
  8. `index.ts` export(신규 public 타입 없으면 무변경).
  9. `electron/harness/lsp-request-methods.ts` 신규(harness-kit): empty clients→[], navigate no-workspace error, symbols no-ready-server, rename SECRET_FILE block, rename denyGlobs block. package.json 등록.
  10. `typecheck` + `build`.
- **건드릴 파일**: `electron/lsp/client.ts`, `electron/lsp/manager.ts`, `electron/agent/tools/file-tools.ts`(applyEdits export), `electron/agent/tools/schemas.ts`, `electron/agent/tools/executors.ts`, `electron/agent/tools/registry.ts`, `electron/agent/tools/types.ts` / **신규**: `electron/agent/tools/lsp-tools.ts`, `electron/harness/lsp-request-methods.ts`
- **수용 기준**:
  - navigate definition → 최소 1개 `relPath:line:col`; references → cap 50.
  - symbols → name/kind/line 트리.
  - rename → (a) prepareRename 먼저·불가 시 error, (b) WorkspaceEdit를 `applyEdits` 통과(SECRET_FILE/denyGlobs 강제), (c) revert history(ToolResult.edits) 반영.
  - rename은 gated(승인 카드), navigate/symbols ungated.
  - ready server 없으면 'No ready LSP server for this file type'(isError) — throw 아님.
  - `typecheck` 통과, harness 5 가드 통과.
- **테스트 계획**: 신규 harness 5 케이스(no-workspace, empty clients, no-ready-server, SECRET_FILE block, denyGlobs block). `typecheck` + `build`. 수동 통합(languages.json에 typescript-language-server): definition 조회, rename 승인 카드→clean apply→diff 확인.
- **의존성**: soft → `applyEdits`가 **export 되어 있어야 함**(현재 `file-tools.ts:247` 비공개 함수). EDIT-1이 이 export를 포함하므로 EDIT-1 이후 권고. EDIT-1을 건너뛰면 LSP-1이 직접 `export`를 추가해야 함.
- **리스크**:
  - rename WorkspaceEdit→oldString 변환이 가장 취약 — LSP 인덱싱 이후 파일 변경 시 oldString 불일치. `applyEdits` staleness 가드가 fresh content로 재시도 유도.
  - prepareRename 미구현 server는 `-32601` → catch 후 rename 직접 호출 또는 'not supported' 반환.
  - 0-based vs 1-based — 모든 메서드(references/rename 포함)에서 line·character 모두 -1 일관 적용.
  - capabilities 확장은 backward-compatible(미구현 server 무시)이나 wire 변경 — diagnostics-only server handshake에 저위험 영향.
  - hover는 MarkupContent|null|string 다양 → 'value' 방어적 추출.
- **확인 필요**:
  - hover를 navigate kind로 vs 별도 lsp_hover — 권고: 별도 tool, 첫 슬라이스 제외.
  - lsp_symbols workspace 스코프 첫 슬라이스 포함 여부 — 권고: document-only 먼저.
  - applyEdits export가 cycle 만드는지(file-tools 의존 모듈이 lsp-tools import 안 함 → cycle 없음, 안전).
  - rename apply를 on-disk range→oldString vs patch.ts에 range-based 모드 추가 — 후자가 깔끔하나 큰 변경, 코딩 전 결정.
  - clients map module-level state + syncFromContext 동시성 race — single-threaded라 event-loop turn 내 안전, disposed client는 ready 가드로 clean error.

---

### MCP-1 — Runtime-MCP 수명주기 강건화: DeferredMCPTool, reconnect base-delay 수정, stable tool-name 정렬
- **priority/effort/approach**: P1 / M / borrow-idea
- **현재 상태**:
  - `mcp-external.ts` tool wrapping이 eager — connect+listTools+registerMcpServer 완료 후에만 registry 등장(`connectServer` L574-610). deferred-tool 개념 없음, 느린 server가 첫 turn에 full connect 지연 추가.
  - reconnect backoff(L766-789), `RECONNECT_BASE_MS=1_000`(L706) → 실제 1000/2000/4000/8000ms. 레퍼런스(gajae manager.ts:890)는 `[500,1000,2000,4000]`. 첫 두 window 상이.
  - `syncExternalMcpServers`(L829)는 live/reconnecting 가드(L864)하나 **pending-connection 중복제거 없음** → 동일 id 동시 호출 2건이 connectServer race, 이중 등록 가능(두 번째 win, 첫 client leak).
  - `listMcpTools()`(mcp.ts:101)는 `allTools()`(mcp.ts:86 `servers.flatMap`)를 connection-완료 순으로 펼친 뒤 고정 built-in tail(…`ASK_USER_DEF`)을 붙임 → **MCP tool은 배열 앞쪽**, 마지막은 안정. `aiTools()`(model.ts:433) sort 없음 → 재연결 순서마다 앞쪽 MCP tool 배열이 변동, Anthropic prefix 캐시 breakpoint 무효화.
  - list-changed 구독(`subscribeListChanges` L659)은 **이미 구현됨**.
  - app-quit teardown(main.ts:537-550)은 correct. turn AbortSignal은 streamText에만 전달, reconnect backoff/callTool timeout에 미연결 — turn abort가 진행 중 reconnect를 취소 안 함.
- **변경 단계**:
  1. `RECONNECT_BASE_MS` 1_000→500 → backoffMs 500/1000/2000/4000/8000(MAX=5, CAP=30_000 불변).
  2. `pendingConnects: Map<string, Promise<McpServerStatus>>` 추가, `connectServer()` 상단에서 `if (pendingConnects.has(id)) return get(id)`, body를 promise로 감싸 저장·finally 삭제.
  3. `DeferredState`(tools/opts/resolve) + `deferred: Map` 도입. connectServer가 cachedTools로 deferred server를 즉시 registerMcpServer(모델이 즉시 인지), 실제 connect settle 시 fully-connected로 교체.
  4. `lastKnownTools: Map<string, McpExternalToolInfo[]>` — listTools 성공 후 set, dispose 시 clear. 비어있으면(첫 connect) deferred skip, eager fallback.
  5. `buildDeferredServer(id, cachedTools, opts, getClient)` — 각 tool exec: `opts.signal?.aborted` 체크, `Promise.race([getClient(), abortPromise(ctx.signal)])`, `client.callTool(..., CALL_TIMEOUT_MS)`.
  6. `clientResolvers: Map` + `resolveClient(id)` — live 있으면 즉시 resolve, 없으면 queue. connectServer 성공 `live.set()` 시 drain. handleUnexpectedClose 시 clear(대기 caller reject→error 경로).
  7. `mcp.ts` `listMcpTools()`에 stable sort — `allTools().sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)`. 반환 slice만 정렬(servers[] in-place 금지).
  8. deferred exec에서 `ctx.signal` race — fire 시 'turn aborted while waiting for MCP server' error ToolResult. client.close() 호출 안 함.
  9. reconnect 시 stale tools 유지(gajae:927) — handleUnexpectedClose에서 lastKnownTools clear 안 함. disconnectServer(고의 teardown)와 syncExternalMcpServers 제거 경로에서만 clear.
  10. harness + `typecheck`/`harness:all`.
- **건드릴 파일**: `electron/agent/mcp-external.ts`, `electron/agent/mcp.ts`, `electron/agent/tools/types.ts`(exec가 ctx:ToolContext signal 포함하는지 확인), `electron/agent/mcp-harness.ts` (신규 없음)
- **수용 기준**:
  - `listMcpTools()`가 연결 순서 무관 동일 알파벳 순.
  - connect 진행 중 turn 시작 시 deferred tools 즉시 등록(lastKnownTools 활용), exec는 실제 client 대기 후 callTool.
  - 대기 중 turn abort → 1 event-loop tick 내 error ToolResult.
  - `RECONNECT_BASE_MS=500` → 첫 reconnect ~500ms.
  - 동일 id 동시 sync 2건 → connection 1회·server 1개(promise 공유).
  - before-quit teardown이 deferred resolver를 reject로 닫음(quit 후 hang 없음).
  - `typecheck`/`harness:all` 통과.
- **테스트 계획**: `mcp-harness.ts`에 — Case A(stable-sort: z_server/a_server 스왑 등록 후 알파벳 순 동일), Case B(deferred: 2s stall, lastKnownTools seed → connectServer 직후 deferred tool 노출, settle 후 실제 client; + abort 중 stall 시 동기 error), Case C(pending dedup: 동시 2회 → ConnectFn 1회). 기존 케이스(backoff/dispose/crash)는 회귀 커버. sort는 `typecheck`로 충분.
- **의존성**: 없음
- **리스크**:
  - deferred 구현 복잡도 — resolver queue 미drain 시 quit 후 hang. dispose에서 reject drain + harness 커버.
  - stale schema 리스크 — reconnect 시 schema 변경 시 connect 완료까지 old schema(레퍼런스 설계 수용, JSDoc 명시).
  - sort 변경은 전 turn의 tool 배열 변경 → 첫 배포 시 1회 캐시 invalidation, 이후 안정(기능 회귀 없음).
  - pendingConnects ↔ cancelReconnect 상호작용 — cancelReconnect가 pendingConnects.get(id)도 clear해야 deliberate connect 미swallow.
  - 500ms 첫 retry는 cold-start 느린 server(Docker)에 round-trip 낭비 가능하나 후속 1000/2000/4000 합리적, 60s idle retry 불변.
- **확인 필요**:
  - 첫 connect(lastKnownTools 없음)에도 deferred 등록할지 — 레퍼런스는 cached list 있을 때만. zero-latency 첫 연결 원하면 startup-time tool-definition 캐시(SQLite/userData) 별도 슬라이스 필요(후속).
  - reconnect 중 stale schema 유지 수용 여부(McpServerStatus에 'reconnecting' 상태 이미 존재 → UI 전달됨).
  - `ToolContext.signal`이 external tool exec 경로에 존재하는지 — 없으면 ToolContext 변경(더 큰 작업), step 5/8 전 확인.
  - `listMcpTools()`가 turn당 1회만 호출되는지(hot path 아니면 O(n log n) 무시).

---

### CACHE-1 — 안정적 system+tools prefix에 prompt-cache breakpoints (Anthropic)
- **priority/effort/approach**: P1 / S / borrow-idea
- **현재 상태**:
  - 현재 Anthropic에 cache_control breakpoint 0개 전송. Anthropic providerOptions는 extended-thinking(reasoning-config.ts:50)와 OAuth 헤더(model.ts:227-233)뿐.
  - `aiTools()`(model.ts:433-443)가 `tool({ description, inputSchema })`를 providerOptions 없이 호출 → tool list에 cache_control 없음. system 프롬프트는 plain string(loop.ts:402, subagent-runtime.ts:253) → SDK가 providerOptions 없는 system 메시지로 변환.
  - 결과: system+tool list가 byte-identical이어도 매 turn cold-cache miss.
- **변경 단계**:
  1. `model.ts` `aiTools(schemas, opts?: { cacheable?: boolean }): ToolSet`. subagent-runtime call-site는 2번째 인자 미전달 → cacheable=false(child prefix는 의도적으로 좁고 call마다 변동, 정답).
  2. `opts?.cacheable === true && schemas.length > 0`이면 **마지막 tool에만** `providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } }`. 마지막 tool은 항상 고정 built-in `ASK_USER_DEF`(mcp.ts:109)라 **위치가 안정적**이므로 breakpoint가 system+tools 전체를 단일 prefix로 커버한다. 나머지 tool 무. SDK(`@ai-sdk/anthropic` prepareTools)가 per-tool 읽어 wire에 cache_control 배치. (SDK 내부 줄번호는 minified dist라 버전마다 이동 — 설치된 `@ai-sdk/anthropic` 버전 기준으로 확인.)
  3. `loop.ts:254` `aiTools(listMcpTools(), { cacheable: current.provider === 'anthropic' })`. current.provider는 activate()의 ActiveTurnModel에서 가용.
  4. 가드 — `schemas.length === 0`이면 부착 대상 없음(cacheable false와 동일 동작).
  5. system 프롬프트는 plain string 유지 — tools 끝 1 breakpoint가 system+tools를 단일 slot으로 커버. system에 2번째 breakpoint는 slot 낭비(tools 비어있지 않을 때). 4-breakpoint cap 무위험.
  6. subagent-runtime.ts 무변경(child tool set은 call마다 좁음, 캐싱 역효과).
  7. `harness:cache-control` 스크립트 추가.
  8. `cache-control-harness.ts` 신규(순수 Node, harness-kit + model.ts만).
  9. `typecheck && harness:cache-control`.
- **건드릴 파일**: `electron/agent/model.ts`, `electron/agent/loop.ts`, `package.json` / **신규**: `electron/agent/cache-control-harness.ts`
- **수용 기준**:
  - `aiTools(schemas, { cacheable:true })`가 **마지막 tool에만** `cacheControl: { type:'ephemeral' }`, 나머지 무.
  - 인자 없음/cacheable:false → 어떤 tool도 providerOptions 없음(기존 동작 보존).
  - `aiTools([], { cacheable:true })` → 빈 객체, 오류 없음.
  - loop.ts provider 체크로 anthropic만 cacheable(openai/google/xai 등은 미추가).
  - `typecheck`/`harness:cache-control` 통과.
  - 수동 trace 시 마지막 Anthropic-bound tool wire JSON에 `cache_control`.
- **테스트 계획**: `cache-control-harness.ts`(순수, `--experimental-strip-types`) — (1) 3 schema+cacheable:true: 마지막만 cacheControl, (2) 1 schema, (3) 3 schema+cacheable:false: 무, (4) empty+cacheable:true: 빈 객체 무throw, (5) 인자 없음: 무. `check()` 사용, 네트워크 불필요. + `typecheck`.
- **의존성**: **MCP-1** (stable tool sort — 없으면 tool 순서 churn으로 hit-rate 저하, correctness는 무관)
- **리스크**:
  - correctness(LOW): breakpoint 오배치는 hit rate만 저하(Anthropic은 advisory).
  - slot budget(LOW): cap 4, CACHE-1은 1 slot 사용. 나머지 3은 future(MCP-1 정렬 + multi-turn message breakpoint)용.
  - tool-order churn(MEDIUM): breakpoint는 안정적 마지막 tool(`ASK_USER_DEF`)에 있지만 **그 앞 prefix에 든 MCP tool**(배열 앞쪽)이 MCP 재연결/mid-conversation 추가·제거로 재정렬되면 breakpoint 이전 prefix 바이트가 바뀌어 miss. 그래서 **MCP-1 stable sort와 짝**. MCP 없거나 정렬되면 적중(hit-rate 이슈, correctness 아님).
  - subagent-runtime(LOW): child는 cacheable 미전달, 정답.
- **확인 필요**:
  - OAuth(Pro/Max) 경로에서 tool list cache_control 수용 여부 — prompt caching은 GA, 동작 예상이나 첫 사용 시 경험적 확인.
  - cache TTL 5m vs 1h — 기본(미설정=5m)이 첫 패스 정답, 세션이 5m 초과·miss 잦으면 1h 업그레이드.
  - MCP-1 미배포 시 MCP server 연결 세션 skip 여부 — 불필요(현 baseline=0 breakpoint보다 나쁠 수 없어 항상 안전 배포).

---

## 4. P2 백로그 (이후 — 여기 spec 없음)

- **composable hook registry** — HOOK-1의 단일 before-turn seam을 다단계/다지점(after-tool, on-error 등) 합성형 레지스트리로 일반화. before-turn 실사용 패턴이 쌓인 뒤 설계해야 과설계 회피.
- **declarative model-capability catalog** — 모델별 기능(thinking/vision/strict 등)을 선언적 카탈로그로. PROV-1/CACHE-1의 provider 분기 누적 후 추출하는 게 자연스러움.
- **worker JS eval kernel** — isolated-worker 내 JS 평가 커널. 보안 격리 설계 비용이 커 별도 슬라이스로 분리.
- **cooperative pause + per-tool concurrency** — 협조적 일시정지 + tool별 동시성 제어. 현 단일-loop 모델에 대한 큰 런타임 변경이라 후순위.
- **source-priority dedup** — 출처 우선순위 기반 중복제거. COMPACT-1의 staleness pruning이 자리잡은 뒤 같은 인덱스 위에 올리는 게 효율적.
- **deep-interview → goal Canvas + GoalRuntime** — Work OS와 **중첩**, 조율 필요. 단독 진행 시 spine 충돌 위험이라 Work OS 팀과 coordinate 후 착수.
- **ACP external-control bridge (off-by-default)** — 외부 제어 브리지. 보안·기본 비활성 정책이 선결이라 deferred.

---

## 5. 착수 제안

**가장 좋은 첫 슬라이스는 EDIT-1**이다. 이유: (1) duplicate-line ambiguity와 같은-파일 다중-op 덮어쓰기는 추정이 아닌 **실제 데이터 손실/차단 버그**이고, (2) `dependsOn: []`로 아무것도 기다리지 않으며, (3) 검증이 순수 harness(`harness:patch-match`)라 비용이 낮고, (4) LSP-1 rename의 apply 경로가 바로 이 강화된 `applyEdits`/`batchValidateAnchors` 위에 올라타므로 토대가 된다.

가장 작고 안전한 첫 행동: **EDIT-1 Step 1-3** — `shared/patch.ts`에 `anchorLine?`/`endAnchorLine?` 추가, `line-anchor.ts`에 `resolveByLineAndHash` 추가, `patch.ts` `resolveEditSpan` 분기. 이것만으로 duplicate-line ambiguity가 즉시 해소되고 op가 없으면 무변경(byte-identical)이라 회귀 위험이 거의 없다. 단 착수 전 open question 하나를 확정해야 한다 — `anchorLine`을 **별도 PatchOp 필드**로 둘지 anchor 문자열에 임베드할지(권고: 별도 필드 = 최소 변경·backward-compatible). 그 다음 자연스러운 단계는 Step 6(같은-파일 op collapse — §C 데이터-손실 버그 수정)과 Step 4-5(AnchorMismatchError + batchValidateAnchors self-heal)로, 덮어쓰기 버그 수정과 배치 self-heal을 완성한 뒤 LSP-1로 넘어가는 것이다.

---

## 리뷰 반영 이력 (2026-06-19)

이 문서는 작성 후 독립 에이전트 2명(critic = 전체 dev-readiness·인용 검증, debugger = §C 버그·EDIT-1 수정안 적대적 검증)으로 리뷰하고 그 결과를 반영했다.

- **EDIT-1 수정안 교정 (핵심):** 초안의 "descending 정렬 + tmp chaining"안에 대해 debugger가 3개 결함을 지적 — (1) 후속 same-file op의 span을 누적 `nextContent`에 재-resolve하지 않으면 offset이 깨짐, (2) full-file 치환 모델에서 descending 정렬은 정확성 불변식이 아님, (3) tmp별 chaining 시 rollback `originalContent`가 어긋남. → **abs당 단일 plan collapse + 직전 `nextContent`에 span 재-resolve**(abs당 tmp/rename 하나) 방식으로 교체(§C, EDIT-1 Step 6·리스크·테스트).
- **§C 데이터-손실 버그:** `multiEdit`→`applyPatch` Phase 1/3 경로를 코드로 trace해 **CONFIRMED**.
- **인용/일관성 정정:** P1 7건(was 6), 프롬프트 9슬롯(was 8, 숫자 인덱스 제거), CACHE-1 마지막 tool은 고정 `ASK_USER_DEF`(메커니즘 교정 — MCP는 배열 앞쪽), MCP-1 `flatMap`은 `mcp.ts:86`(`allTools`), LSP-1 notification은 `client.ts:130-156`·`applyEdits` export는 soft-dependency, `@ai-sdk/*` dist 줄번호는 버전 고정 후 재확인 caveat.