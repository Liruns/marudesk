# marudesk — Agentic AI Chat **v2** 설계 (Claude/Codex Desktop 급 재설계)

> 상태: **설계 (2026-05-31)** · 범위: ① Vercel AI SDK 채택(두 겹 driver 통합 + 스트리밍) ② model-first provider 시스템(설정 재설계 + 커스텀 엔드포인트) ③ Claude/Codex Desktop 급 채팅 UX
> 전제 결정: **Vercel AI SDK 채택** + **설계 문서부터** (2026-05-31 사용자 확정).
> 동반: [v1 설계](./agentic-chat-design.md)(assist→agent 루프 실현, 구현 완료) · [로드맵](./roadmap.md) · [positioning](./roadmap.md#L15) · 참고: stagewise-io/stagewise (`ai@6` + `@ai-sdk/*`)

---

## 0. 한 줄

v1은 **agentic 루프(plumbing)**를 실현했다(멀티턴 도구 루프, accept/revert, approval, ask_user). v2는 그 위에 **제품 표면**을 Claude/Codex Desktop 급으로 끌어올린다: 손으로 짠 provider driver 두 겹을 **Vercel AI SDK 하나로 통합**(→ 토큰 스트리밍 + 전 provider 동작 + 커스텀 엔드포인트), provider 설정을 **provider-first → model-first**로 뒤집고, 채팅 UX를 다듬는다. **차별점(CDP 런타임 도구)은 더 도드라지게** 보존한다.

## 1. 왜 v2 — 진단 (갭 3개)

v1은 "루프가 도는가"를 풀었지 "매일 켜고 싶은 제품인가"를 풀지 않았다. 구체적 갭:

| # | 갭 | 증거 (코드) | 체감 |
|---|---|---|---|
| **G1** | **스트리밍이 가짜** — 토큰이 흐르지 않고 스텝 단위로 뭉텅이 | [driver.ts:64](../electron/agent/driver.ts#L64) `messages.create`(non-stream); [loop.ts:186](../electron/agent/loop.ts#L186)는 완성된 `StepResult`만 받음 | 에이전트가 "멈춰 있다가 뱉는다" |
| **G2** | **provider-first 설정이 구림** — provider 탭 고르고→모델 고르고→키 붙여넣기. 채팅 헤더가 provider 탭 4개에 점유됨 | [providers.ts](../shared/providers.ts) `PROVIDERS[]`(each has `models[]`); [AgentChat.tsx:176](../src/features/agent/AgentChat.tsx#L176) `ProviderModelBar`; [ProvidersSettings.tsx](../src/features/settings/ProvidersSettings.tsx) | Claude/Codex Desktop은 모델만 고르면 끝 |
| **G3** | **채팅 UX 미니멀** — tool 카드 1종, 세션 없음, context-usage 없음, plan 없음, reasoning 없음 | [AgentChat.tsx](../src/features/agent/AgentChat.tsx) `ToolCardView` 단일 | 일반 코딩 에이전트 클론처럼 보임 |

**숨은 부채 (G1/G2를 동시에 키우는 뿌리):** provider 로직이 **두 군데 중복**이다.
- `electron/providers/`(`ProviderDriver`: `propose`+`listModels`) — 4 driver 파일, [llm.ts](../electron/llm.ts)·[models.ts](../electron/models.ts)가 소비 (assist one-shot).
- `electron/agent/driver.ts`(`AgentDriver`: `step`) — 손으로 짠 Anthropic SDK + OpenAI-compat fetch. **Google 미지원**([loop.ts:371](../electron/agent/loop.ts#L371) "currently supports Anthropic"), 스트리밍 없음.

두 겹 다 통합 SDK 없이 손으로 message 매핑(`toAnthropicMessages`/`toOpenAIMessages`)·tool 스키마 변환을 반복한다. **AI SDK 한 번 도입이 G1(스트리밍)·G2(통합 모델)·중복을 한 번에 정리한다.**

## 2. 결정 요약

1. **Vercel AI SDK(`ai@6` + `@ai-sdk/*`) 채택** — `electron/providers/*`(propose)와 `electron/agent/driver.ts`(step)를 **하나의 모델 레이어**로 통합. 스트리밍·tool-calling·provider 추상화·커스텀 엔드포인트가 거의 공짜.
2. **model-first 데이터 모델** — `PROVIDERS[](each.models)` → **flat `MODELS[]`(각 모델이 `provider`를 필드로)** + 커스텀 provider 목록. UI는 모델을 고르고 provider는 따라온다.
3. **채팅 UX는 Claude/Codex Desktop 패리티** — 단, **CDP 런타임 도구(get_console_errors/query_dom/eval_js/read_network/reload_and_verify)를 1급 카드**로 끌어올려 *차별점을 더 보이게*. 일반 코딩 에이전트 클론이 되지 않는다([positioning](./roadmap.md#L15)).
4. **루프 소유권은 그대로 main** — AI SDK는 *한 스텝*(`streamText` 1회)에만 쓰고, 멀티턴·parking(approval/ask_user)·gating·edits accept/revert는 [loop.ts](../electron/agent/loop.ts)가 계속 소유. (stagewise의 `stopWhen:()=>true`와 동일 철학 — 우리는 이미 그렇게 짜여 있고, SDK로 *바꾸는 건 step 한 줄*.)

## 3. 차용 / 기각 (stagewise · Claude/Codex Desktop)

**차용:**
1. **AI SDK `streamText` 한 스텝 운전** — tool에 `execute`를 *주지 않으면* SDK가 tool-call에서 멈추고 우리에게 돌려줌 → loop.ts가 기존대로 실행/parking. (`stopWhen` 불필요; execute 없는 tool은 자연히 한 스텝에서 끝남.)
2. **model-first 선택** — 검색되는 모델 콤보박스(provider 그룹, context window 표시). settings는 **provider 카드**(계정 모드는 우리 비-목표 → "내 키" + "커스텀"만).
3. **커스텀 OpenAI-compatible 엔드포인트** — `@ai-sdk/openai-compatible` 하나로 OpenRouter/LM Studio/vLLM/Together/Groq까지 코드 없이 해금.
4. **tool별 전용 카드** — read=compact, edit/write=인라인 diff, eval_js=결과, reload_and_verify=✅에러사라짐/🔁잔존.
5. **context-usage 표시** + **reasoning(thinking) 접이식 블록** + (옵션) **plan-first 카드**.
6. **세션 사이드바**(옵션, Phase 5) — 단, **단일 활성 대화 모델은 유지**(parking·transcript 부기 단순).

**기각(복사 안 함):**
- **stagewise 계정/LLM 게이트웨이(`llm.stagewise.io`)** — 우리는 BYOK + 로컬(Ollama) + 커스텀만. 호스팅 게이트웨이는 dogfood/포트폴리오 목표 밖.
- **Karton(WebSocket 상태 동기 + Immer 패치)** — 우리 turn은 bounded라 `agent:event` **스냅샷/틱**으로 충분(v1 결정 유지). 토큰 스트리밍도 스냅샷-퍼-틱으로 표현됨(§5.3).
- **history compression / 멀티 워크스페이스 mount / git worktree 표면 / 16개 범용 tool 풀세트** — FREEZE(넓이 < CDP 한 루프의 깊이). 우리 tool 카탈로그(§v1 §4)는 *런타임 CDP*가 핵심.
- **plan을 강제 게이트로** — 우리는 옵션(과한 의례 방지).

## 4. 아키텍처 A — AI SDK 통합 (G1 + 중복 부채)

### 4.1 의존성
```
ai                          (v6.x — streamText, tool, jsonSchema, ModelMessage)
@ai-sdk/anthropic           (createAnthropic)
@ai-sdk/openai              (createOpenAI)
@ai-sdk/google              (createGoogleGenerativeAI)
@ai-sdk/openai-compatible   (createOpenAICompatible — Ollama + 커스텀)
zod                         (tool 스키마; 기존 JSON Schema는 jsonSchema()로 브리지 가능 — 재작성 불필요)
```

### 4.2 새 모델 레이어 — `electron/agent/model.ts` (driver.ts 대체)
역할 둘로 축소: **(a) 모델 인스턴스 빌드**, **(b) 도구 스키마 브리지**.
```ts
// (a) modelRef = 선택된 모델(+해소된 provider/key/baseUrl) → AI SDK LanguageModel
export function buildModel(ref: ResolvedModel): LanguageModel {
  switch (ref.kind) {
    case 'anthropic': return createAnthropic({ apiKey: ref.apiKey })(ref.modelId);
    case 'openai':    return createOpenAI({ apiKey: ref.apiKey })(ref.modelId);
    case 'google':    return createGoogleGenerativeAI({ apiKey: ref.apiKey })(ref.modelId);
    case 'openai-compatible': // Ollama(localhost:11434/v1, no key) + custom
      return createOpenAICompatible({ name: ref.label, baseURL: ref.baseUrl, apiKey: ref.apiKey })(ref.modelId);
  }
}
// (b) 기존 TOOL_SCHEMAS(JSON Schema)를 AI SDK tool로 — execute 없음(= 수동 실행)
export function aiTools(schemas: ToolSchema[]) {
  return Object.fromEntries(schemas.map((t) => [t.name,
    tool({ description: t.description, inputSchema: jsonSchema(t.inputSchema) })]));
}
```
**삭제 대상**(driver.ts 안): `LoopContent`/`LoopMessage` 중립 타입, `toAnthropicMessages`, `toOpenAIMessages`, `makeOpenAICompatDriver`, `AGENT_DRIVERS`, `AgentDriver`/`StepResult`/`StepOptions`. → AI SDK의 `ModelMessage`가 중립 transcript 타입을 대신함.

### 4.3 loop.ts step 교체 (스트리밍 획득 — 변경은 *한 군데*)
[loop.ts:184–217](../electron/agent/loop.ts#L184)의 `driver.step(...)` 한 블록만 교체. **parking/gating/edits/finish는 전부 불변.**
```ts
const res = streamText({
  model: buildModel(opts.resolved),
  system: SYSTEM_PROMPT,
  messages: transcript,           // ModelMessage[]
  tools: aiTools(TOOL_SCHEMAS),    // execute 없음 → tool-call에서 멈춤
  abortSignal: opts.signal,
});
// 토큰 델타를 진행 중 assistant 메시지에 누적 → emit()마다 스트리밍처럼 보임 (G1 해결)
for await (const part of res.fullStream) {
  if (part.type === 'text-delta') { appendAssistantText(part.text); emit(); }
  // 'reasoning-delta'가 있으면 thinking 파트에 누적 (§6.3)
}
const toolCalls = await res.toolCalls;   // 모델이 부른 tool들
const usage = await res.usage;           // {inputTokens, outputTokens, ...}
// ↓ 이하 기존 loop.ts 그대로: calls→ToolCall, gating, executeTool, tool-result push, 재진입
```
> 필드명(`text-delta`/`fullStream`/`usage`)은 설치된 AI SDK 버전에 맞춰 구현 시 확인(라인은 shift 가능 — v1 관례).

### 4.4 propose 경로(assist one-shot) 처리 — **열린 결정 D1 (§9)**
- **권장 = 흡수(삭제):** agent 루프가 one-shot을 포괄한다(같은 tool로 읽고 고침). [llm.ts](../electron/llm.ts) `proposePatch`/`buildUserMessage`, `electron/providers/*`의 `propose`, [shared/composer.ts](../shared/composer.ts)의 propose 타입, Composer "Quick patch" 토글 제거 → **두 겹 driver가 정말 한 겹으로**. 단, 캡처 첨부 UX는 agent 첫 user 메시지로 계속 전달(이미 [loop.ts:399](../electron/agent/loop.ts#L399) `buildUserText`).
- **대안 = 유지:** Quick patch를 남기되 `propose`를 `generateText`로 이전. 코드 경로 둘 유지(비추 — 중복 부채 잔존).

`listModels`(모델 카탈로그 라이브 fetch, [models.ts](../electron/models.ts))는 generation과 무관하므로 **어느 쪽이든 유지** — model-first 카탈로그를 채우는 데 그대로 쓰임.

## 5. 아키텍처 B — model-first provider 시스템 (G2)

### 5.1 데이터 모델 — `shared/providers.ts` 재작성
provider-first(`PROVIDERS[].models`)를 flat model-first로 뒤집되, **`ProviderId` 유니온은 유지**(key 저장·provider 인스턴스 생성의 compile-time 게이트로 계속 유용).
```ts
export type ProviderId = 'anthropic' | 'openai' | 'google' | 'ollama' | `custom:${string}`;
export type ProviderKind = 'anthropic' | 'openai' | 'google' | 'openai-compatible';

export type ModelEntry = {
  id: string;            // API로 보내는 모델 id ('claude-sonnet-4-6')
  label: string;        // 'Claude Sonnet 4.6'
  provider: ProviderId;  // 누가 서빙하나
  contextWindow?: number;// 콤보박스/usage 링
  tools?: boolean;       // tool-use 가능 모델만 agent에 노출(예: ollama 일부 제외)
};

export const MODELS: ModelEntry[] = [ /* anthropic·openai·google·ollama 기본 카탈로그, 평면 */ ];

// 커스텀(OpenAI-compatible) — 사용자가 settings에서 추가, 설정에 저장(키는 secrets)
export type CustomProvider = {
  id: string;            // → ProviderId `custom:${id}`
  label: string;        // 'OpenRouter'
  kind: 'openai-compatible';
  baseUrl: string;       // 'https://openrouter.ai/api/v1'
  models: ModelEntry[];  // 수동 입력 또는 /models 라이브
};
```
`getProvider`/`isProviderId`는 유지(시그니처 조정). 선택 단위는 이제 **`modelId`**(provider는 `MODELS`/커스텀에서 역참조).

### 5.2 provider 상태 분리 — `src/features/providers/store.ts` (신규)
지금 [composer/store.ts](../src/features/composer/store.ts)가 **composer + provider + key editor + model fetch + connection test**를 다 떠안은 게 G2의 데이터 레이어 원인. 이를 분리:
- **신규 `providers/store.ts`**: `selectedModelId`, `models`(flat, 라이브 머지), `providerStatus`(키 유무), 키 editor(`keyProvider/keyInput/...`), `customProviders`, `testConnection`. localStorage는 `selectedModelId` 하나만(provider+modelByProvider 맵 폐기).
- **`composer/store.ts`**: propose 흡수 시 거의 비거나 제거(D1).

### 5.3 secrets — `electron/secrets.ts`
거의 그대로(safeStorage 암호화 = stagewise와 동일, 잘 돼 있음). 변경:
- `CredMap` 키 타입을 `ProviderId`(템플릿 `custom:${string}` 포함)로 완화 → 커스텀 키도 같은 금고에.
- 커스텀 provider **설정**(label/baseUrl/kind)은 비밀이 아니므로 settings 저장(또는 creds 파일에 병기). 키만 secrets.

### 5.4 모델 해소 (선택 modelId → 호출 가능한 ResolvedModel)
main에 작은 해소기(`electron/agent/resolve-model.ts` 또는 model.ts 내부):
```
resolve(modelId): { kind, modelId, apiKey?, baseUrl?, label }
  = MODELS/customProviders에서 modelId→provider→kind→key(secrets)/baseUrl 조합
```
[loop.ts](../electron/agent/loop.ts) `startTurn`의 `getProviderApiKey(input.provider)` + keyless 분기를 이 해소기로 대체. agent send 입력도 `{provider, model}` → **`{modelId}`**.

## 6. 아키텍처 C — 채팅 UX (G3, Claude/Codex Desktop 패리티)

### 6.1 in-chat 모델 셀렉터 (provider 탭 제거)
[AgentChat.tsx](../src/features/agent/AgentChat.tsx) `ProviderModelBar` → **검색 콤보박스**: 전 모델 flat 리스트, provider별 그룹 헤더, context window 표시, 키 없는 모델은 "키 추가" 인라인 CTA(Settings 딥링크는 유지). 채팅 헤더가 가벼워짐.

### 6.2 tool별 전용 카드 (차별점 노출)
단일 `ToolCardView` → tool 이름으로 분기:
| tool | 카드 |
|---|---|
| `read_file`/`list_files`/`grep` | compact(파일명+요약), 접힘 |
| `edit_file`/`multi_edit` | **인라인 diff**(기존 `DiffBlock` 재사용) + Keep/Revert(이미 있음) |
| `get_console_errors` | **에러 + confidence 태그 + 해소 파일**(런타임 증거 강조) |
| `query_dom` | selector + outerHTML 미리보기 |
| `eval_js` | 승인 게이트(있음) + 결과(scrub됨) |
| `read_network` | status/triage 프레이밍 + body 미리보기(scrub) |
| `reload_and_verify` | **✅ 에러 사라짐 / 🔁 잔존** — 닫힌 루프의 하이라이트 |

### 6.3 스트리밍·reasoning·usage
- **스트리밍 커서**: §4.3 텍스트 델타 누적 → 진행 중 메시지에 caret.
- **reasoning 블록**: 모델이 reasoning 델타를 주면 접이식 "Thinking" 블록(Claude/Codex Desktop 느낌).
- **context-usage**: `usage{inputTokens}` + 선택 모델 `contextWindow` → 작은 링/바. `shared/agent.ts`의 usage에 `contextWindow` 추가.

### 6.4 (옵션) plan-first 카드 — Phase 5
에이전트가 `plans/*.md`를 쓰면 그 스텝에서 멈추고 "Open Plan / Implement" 카드. stagewise 패턴이되 **강제 아님**.

### 6.5 (옵션) 세션 사이드바 — Phase 5
현재 모듈-레벨 단일 `state`+`transcript` → `sessions: Map<id,{state,transcript}>` + activeId + 디스크 영속. UI 좌측 세션 목록. **단일 활성 대화 실행 모델은 유지**(동시 실행 아님 — parking 부기 단순).

## 7. 전체 마이그레이션 맵 (파일별)

> 범례: ✏️ 변경 · ♻️ 재작성 · ➕ 신규 · ❌ 삭제(D1=propose 흡수 시) · ✅ 유지

### main (electron/)
| 파일 | 처리 | 내용 |
|---|---|---|
| `electron/agent/driver.ts` | ♻️→`model.ts` | AI SDK `buildModel` + `aiTools`만. 중립 타입·매퍼·AGENT_DRIVERS 삭제 |
| `electron/agent/loop.ts` | ✏️ | step만 `streamText`로(§4.3); send 입력 `{modelId}`; "Anthropic만" 가드 제거; 모델 해소기 사용 |
| `electron/agent/resolve-model.ts` | ➕ | `modelId → ResolvedModel`(provider/key/baseUrl) |
| `electron/agent/tools.ts` | ✅ | tool 실행기 불변(스키마는 `aiTools`가 브리지) |
| `electron/agent/history.ts`·`handlers.ts` | ✅/✏️ | accept/revert 불변; handlers는 send 페이로드 타입만 |
| `electron/providers/{anthropic,openai,google,ollama}.ts` | ❌ propose / ✅ listModels | D1이면 propose 삭제. listModels는 살리거나 model.ts로 이전 |
| `electron/providers/{index,types,tool}.ts` | ✏️/❌ | `ProviderDriver.propose` 제거(D1); `listModels`만 남기면 슬림 |
| `electron/llm.ts` | ❌ (D1) | proposePatch/buildUserMessage 제거. (유지 시 `generateText`로 이전) |
| `electron/models.ts` | ✏️ | model-first 카탈로그 반환(`ModelEntry[]`), 캐시 유지 |
| `electron/secrets.ts` | ✏️ | CredMap 키에 `custom:${string}`; 커스텀 설정 저장 |

### shared/
| 파일 | 처리 | 내용 |
|---|---|---|
| `shared/providers.ts` | ♻️ | model-first: `MODELS[]` + `ModelEntry` + `CustomProvider` + `ProviderKind`. `ProviderId` 유니온 유지(+custom) |
| `shared/agent.ts` | ✏️ | `AgentSendInput {provider,model}`→`{modelId}`; usage에 `contextWindow`; (옵션) reasoning 파트, sessions |
| `shared/composer.ts` | ✏️/❌ | propose 타입 제거(D1) |
| `shared/ipc.ts` | ✏️ | `agent:send` 페이로드(`modelId`); `providers:add/remove/list-custom` 추가; `llm:propose-patch` 제거(D1); `IpcMapIsComplete`/`EVENT_CHANNELS` 갱신 |

### renderer (src/)
| 파일 | 처리 | 내용 |
|---|---|---|
| `src/features/providers/store.ts` | ➕ | provider/model/key 상태(composer에서 분리). model-first |
| `src/features/providers/ModelSelect.tsx` | ➕ | 검색 콤보박스(그룹/context window) — in-chat + settings 공용 |
| `src/features/providers/ProviderCards.tsx` | ➕ | settings: provider 카드 + 커스텀 엔드포인트 추가 UI |
| `src/features/settings/ProvidersSettings.tsx` | ♻️ | provider 탭 → 카드 + 커스텀. providers/store 소비 |
| `src/features/settings/SettingsView.tsx` | ✏️ | "AI Providers" blurb/아이콘만(model-first 문구) |
| `src/features/agent/AgentChat.tsx` | ♻️ | `ProviderModelBar`→`ModelSelect`; tool별 카드(§6.2); 스트리밍 커서; usage 링 |
| `src/features/agent/store.ts` | ✏️ | model-first 선택; 스냅샷 투영 유지(스트리밍 자동); (옵션) sessions |
| `src/features/composer/store.ts` | ❌/✏️ | propose 흡수 시 제거; provider 상태는 providers/store로 이미 이전 |
| `src/features/composer/*`(Quick patch UI) | ❌ (D1) | agent 단일화 |

### 테스트
| | 처리 |
|---|---|
| e2e fake-driver | ✏️ AI SDK `MockLanguageModelV2`/`simulateReadableStream`으로 교체 → 여전히 실 LLM 호출 없음(v1 결정 계승). 루프/스트리밍/parking 결정론 검증 |

## 8. 단계 (각 단계 typecheck + `npm run build`/`test:e2e` 그린)

1. **데이터 모델 + provider 스토어 분리** (G2 토대): `shared/providers.ts` model-first + `MODELS`; `src/features/providers/store.ts` 신설(composer에서 provider 상태 이전). 기존 UI는 새 스토어 읽도록 최소 배선. *동작 동일, 컴파일 그린.*
2. **AI SDK 스왑** (G1 + 중복): deps 추가; `model.ts`(buildModel/aiTools); `loop.ts` step→`streamText`(스트리밍 획득); 손 driver·매퍼 삭제; resolve-model. **전 provider + 커스텀 동작.** Mock 모델 e2e.
3. **provider UX** (G2 완성): Settings provider 카드 + 커스텀 OpenAI-compat 엔드포인트; in-chat `ModelSelect`(provider 탭 제거).
4. **채팅 UX 폴리시** (G3): tool별 카드, context-usage 링, 스트리밍 커서, reasoning 블록.
5. **(옵션)** 세션 사이드바 + 영속; plan-first 카드.
- **D1(propose 흡수)** 은 Phase 2에 접거나 별도 정리 커밋. 운영 리듬: 큰 폭포수 금지, 단계마다 dogfood.

## 9. 열린 결정 (구현 전 확정)

- **D1 — one-shot propose 경로:** 흡수(삭제, 권장) vs 유지(`generateText` 이전). → 두 겹 driver를 정말 한 겹으로 만들지의 핵심.
- **D2 — 세션:** 단일 대화(현행) 유지 vs 세션 사이드바+영속(Phase 5). 첫 출시엔 단일로도 충분할 수 있음.
- **D3 — 커스텀 endpoint 스펙 범위:** `openai-compatible` 하나(OpenRouter/LM Studio/vLLM/Together/Groq 커버, 권장) vs `anthropic` 호환도. (stagewise는 7종 — 우리는 과함.)
- **D4 — Ollama tool 모델 게이팅:** tool-use 불가 로컬 모델을 agent 셀렉터에서 숨길지(`ModelEntry.tools`).

## 10. 비-목표 / 보존

- **positioning 보존:** 차별점은 **런타임 CDP 도구**(도는 앱을 보고 검증). UX 폴리시가 이걸 *덮지 말고 드러내야* 함(§6.2). 일반 코딩 에이전트 경쟁 아님([roadmap §4](./roadmap.md)).
- **FREEZE 유지:** stagewise 계정/게이트웨이, Karton, history compression, 멀티 워크스페이스 mount, git worktree 표면, 범용 16-tool 풀세트 — 채택 안 함.
- **보안 불변:** `readFileSafe`/`applyPatch`(atomic)/`sendCdp`(allowlist)/scrub(P0.5) 전부 재사용 — AI SDK는 *모델 호출*만 대체, fs/CDP 권한 표면은 신설 없음.
- **에이전트 두뇌 자체제작 안 함** — provider 모델 사용(이게 AI SDK 채택의 본질).

## 11. 부록 — v1 대비 무엇이 바뀌나 (한눈)

| 차원 | v1 (현행) | v2 (목표) |
|---|---|---|
| provider 연결 | 손 driver 2겹(SDK 없음) | Vercel AI SDK 1겹 |
| 스트리밍 | ❌ 스텝 뭉텅이 | ✅ 토큰 |
| provider 범위 | agent는 Anthropic/OpenAI/Ollama(Google 빠짐) | 전 built-in + 커스텀 OpenAI-compat |
| 선택 모델 | provider 탭 → 모델 | model-first 콤보박스 |
| 설정 | provider 탭 + 키 붙여넣기 | provider 카드 + 커스텀 엔드포인트 |
| tool 카드 | 1종 | tool별(런타임 증거 강조) |
| context usage / reasoning / 세션 | 없음 | 있음(세션은 옵션) |
| 루프 소유 | main 수동 step | **동일**(step만 streamText) |

---

### 부록 — 결정 로그
- **2026-05-31:** v1(루프) 구현 완료 확인 → 사용자가 "제품 표면이 Claude/Codex Desktop 급 아님 + provider 설정 구림" 지적. stagewise(`ai@6`+`@ai-sdk/*`, model-first, safeStorage, plan-first, diff-history) 정찰.
- **2026-05-31:** **Vercel AI SDK 채택** + **설계 문서부터** 확정. 두 겹 driver 통합·model-first·UX 폴리시·CDP 차별점 보존을 v2로 분리 문서화(이 파일).
