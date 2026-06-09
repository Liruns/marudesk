# marudesk — 무료 AI provider **설계문서** (keyless 무료 + 무료 티어 큐레이션)

> 상태: **설계 (2026-06-09)** · 범위: "키·과금 없이 쓸 수 있는 AI"를 어떻게 노출할지 두 갈래
> (keyless 클라우드 / 무료 티어 큐레이션)로 나눠 기존 seam 위에 얹는 설계.
> 부모 문서: [provider-expansion-plan.md](./provider-expansion-plan.md)(§3 흡수 매트릭스, §6 변경 맵) ·
> [oauth-providers-design.md](./oauth-providers-design.md)(§9 config seam)

---

## 0. 한 줄

지금 provider 16종 중 **키 없이 쓰는 길은 Ollama(로컬) 하나**다(`keyless: true`). 첫 실행 사용자가
**아무 가입·키 발급·로컬 설치 없이** 즉시 에이전트를 돌려볼 수 있게, (A) **keyless 무료 클라우드
provider 1종**을 Ollama와 같은 seam으로 추가하고, (B) 이미 들어와 있는 **무료 티어**(Groq / Cerebras /
Gemini / OpenRouter `:free`)를 "Free"로 라벨링한다.

## 1. 동기

- **온보딩 마찰**: 현재 BYOK가 기본이라, 키가 없는 첫 사용자는 에이전트를 한 번도 못 돌려보고 이탈한다.
  Ollama는 키가 없지만 로컬 설치·모델 pull이 필요해 "즉시"는 아니다.
- **seam은 이미 있다**: `keyless` 플래그가 `resolve-auth.ts:38` / `secrets.ts:129` / `models.ts:73` /
  `model.ts`(ollama case) 전 경로에서 존중된다. 무료 클라우드 provider는 **base URL만 다른 Ollama**다.
- **무료 티어는 데이터 추가**: Groq/Cerebras/Gemini/Mistral은 이미 built-in이고 넉넉한 무료 티어가 있다.
  "Free" 노출은 신규 메커니즘이 아니라 **카탈로그 메타 + UI 배지**다.

## 2. "무료"의 두 정의 (이 문서가 다루는 범위)

| 구분 | 뜻 | 키 | 안정성 | 작업 성격 |
|---|---|---|---|---|
| **A. keyless 무료 클라우드** | 가입·키 없이 referrer/익명으로 호출 | **불필요** | 낮음(레이트리밋·tool 불안정) | 신규 provider 1종(데이터+케이스) |
| **B. 무료 티어 큐레이션** | 키는 받지만 과금 0인 모델 | 필요 | 높음 | 카탈로그 메타 + UI 배지 |

> 두 정의를 **한 provider에 섞지 않는다.** A는 "지금 당장 0설정"이 가치고, B는 "안정적 무료"가 가치다.
> UI에서도 A는 keyless 카드, B는 키 카드에 배지로 구분한다.

## 3. A안 — keyless 무료 클라우드 provider

### 3.1 후보 매트릭스

| 후보 | 엔드포인트 | 인증 | OpenAI 호환 | tool calling | 비고 |
|---|---|---|---|---|---|
| **Pollinations** | `text.pollinations.ai/openai` | 없음(referrer) | ✅ `chat/completions` | 일부 모델만(openai/mistral 계열) | 무료·무키, 레이트리밋 있음 |
| HuggingFace Inference (무료 한도) | router 경유 | **토큰 필요** | ✅ | 모델별 | 무키 아님 → A 부적합, B/`custom:*`로 |
| OpenRouter `:free` | `openrouter.ai/api/v1` | **키 필요** | ✅ | 모델별 | 무키 아님 → B로 |

→ **무키(無 키)** 조건을 만족하는 1차 후보는 **Pollinations** 뿐이다. 나머지는 키가 있어 B/`custom:*`로 간다.

> ⚠️ 부모 문서 §9와 같은 주의: 무키 무료 엔드포인트의 base URL·모델 목록·tool 지원은 **비공식/회전
> 가능**하다. 실제 채택 전 dogfood로 (1) 무키 호출 성공, (2) tool calling 왕복, (3) 레이트리밋 한도를
> 확인하고 **`experimental: true` 표기**로 출시한다.

### 3.2 핵심 제약 — 에이전트는 tool calling이 필수

marudesk 에이전트 루프는 도구 호출 모델만 쓸 수 있다(`ModelEntry.tools`, 모델 선택기의 capability
배지). 따라서 keyless 무료 provider의 **시드 카탈로그에는 tool-capable 모델만** 넣고, tool 미지원
모델은 노출하지 않는다. 라이브 `/models`에서 능력을 못 받으면 보수적으로 `tools: true`만 단 소수만
시드한다.

### 3.3 변경 맵 (Ollama seam 재사용 — 대부분 데이터)

```
shared/providers.ts
  - BuiltinProviderId += 'pollinations'(예시 id)
shared/provider-catalog.ts
  - PROVIDERS += { id:'pollinations', label:'Pollinations (Free)', keyless:true, experimental:true,
                   models:[…tool-capable 소수…], defaultModelId,
                   apiKeyPlaceholder:'(무료 — 키 없음)', apiKeyHint:'키·가입 없이 사용. 레이트리밋 있음.' }
  - MODELS += 해당 시드(전부 tools:true, contextWindow는 아는 것만)
electron/agent/model.ts
  - const POLLINATIONS_BASE_URL = 'https://text.pollinations.ai/openai'
  - case 'pollinations': return createOpenAICompatible({ name:'pollinations',
        baseURL: POLLINATIONS_BASE_URL })(modelId)   // ← apiKey 없음, ollama case와 동일 형태
electron/providers/index.ts
  - DRIVERS += pollinations: openAiCompatibleDriver({ name:'Pollinations',
        modelsUrl:'https://text.pollinations.ai/openai/models' or 'https://text.pollinations.ai/models' })
src/features/providers/ProviderGlyph.tsx (선택)
  - 글리프 추가(없으면 generic 모노그램)
e2e/provider-catalog.spec.ts
  - 카탈로그 정합성(신규 provider/모델 카운트) + keyless 라운드트립(키 없이 hasKey=true)
```

기존 `keyless` 경로가 **이미** "키 없으면 ready 취급 + 키 요구 스킵"을 처리하므로
(`secrets.ts:129` `hasKey: !!p.keyless || …`, `resolve-auth.ts:38`, `models.ts:73`),
**secrets/auth/settings 쪽 신규 코드는 없다.** Ollama가 검증해 둔 길을 그대로 탄다.

## 4. B안 — 무료 티어 큐레이션 (키 필요, 과금 0)

### 4.1 접근

신규 provider 없음. 이미 있는 provider의 모델에 **무료 메타**를 달고 UI에 배지를 띄운다.

- **대상**: `groq`(무료 티어 넉넉) · `cerebras`(무료 티어) · `google`(Gemini 무료 티어) ·
  `openrouter`(`*:free` 모델군) · `mistral`(무료 실험 티어).
- **메타 추가**: `ModelEntry`에 `free?: boolean` 또는 `tier?: 'free' | 'paid'` 선택 필드.
  - OpenRouter는 id가 `…:free`로 끝나는지로 **파생**(데이터 중복 없이 런타임 판별)도 가능.
- **UI**: 모델 선택기(`ModelPalette*`)에 capability 배지처럼 "Free" 칩 1개. Settings provider 카드
  힌트에 "무료 티어 있음" 한 줄.

### 4.2 변경 맵 (UX 중심, 메커니즘 없음)

```
shared/providers.ts        - ModelEntry += free?:boolean (또는 tier)  ※ 선택
shared/provider-catalog.ts - 무료 티어 모델에 free:true, OpenRouter :free 시드 몇 종 추가
src/features/agent/ModelPalette*.tsx - "Free" 배지 렌더(기존 vision/reasoning 배지와 같은 자리)
src/features/settings/ProviderCard.tsx - apiKeyHint에 무료 티어 안내(데이터만)
i18n - "Free" 라벨 키
```

→ TS 타입 1개 추가 + 데이터 + 배지. **드라이버·auth·secrets 무변경.**

## 5. 단계 (phased)

1. **B안 먼저(저위험)**: `ModelEntry.free` + 무료 티어 모델 라벨링 + "Free" 배지 + OpenRouter `:free`
   시드 몇 종. 키는 필요하지만 안정적이라 즉시 가치.
2. **A안(실험)**: Pollinations(또는 dogfood로 검증된 무키 엔드포인트) keyless provider 추가.
   `experimental: true`로 출시, 모델 선택기 "Experimental" 그룹에 배치(부모 v4 §A1 규칙).
3. **검증**: `npm run typecheck` + `npm run build` + e2e `provider-catalog.spec.ts`(카탈로그 정합성·
   keyless 라운드트립) + **무키 호출/tool 왕복 dogfood**(A안). 무료 티어는 실 키로 1턴 왕복 확인.

## 6. 비목표

- **유료 provider를 무료처럼 보이게 하기**: "Free" 배지는 **실제 무료 티어/무키만**. 오해 소지 금지.
- **자체 프록시/공유 키 운영**: marudesk가 중앙에서 키를 쥐고 무료로 뿌리는 모델 — 비용·악용·ToS 부담
  으로 범위 밖. 어디까지나 **vendor 무료 경로 노출**만.
- **keyless 무료 provider를 기본 모델로**: `DEFAULT_MODEL_KEY`는 안정성 때문에 Anthropic 유지.
  무료는 "키 없는 사용자가 골라 쓰는 옵션"이지 디폴트가 아니다.

## 7. 위험 / 주의

- **무키 엔드포인트 불안정**: 레이트리밋·간헐 장애·tool 미지원 모델 혼재 → `experimental` + 실패
  메시지에 "무료 provider 한도/장애 가능" 안내(부모 §9 패턴).
- **ToS 회색지대**: 무키 무료 API의 비공식 사용 약관을 채택 전 확인(부모 §9 Copilot 주의와 동일 결).
- **"Free"의 정확성**: 무료 티어 한도/만료(예: 일부 무료 티어는 기간/쿼터 제한)는 회전 가능 — 배지는
  보수적으로, 힌트에 "한도 적용" 명시.
- **tool 미지원 모델 노출 금지**: 에이전트가 못 쓰는 모델을 무료라고 띄우면 즉시 실패 경험 → §3.2대로
  tool-capable만 시드.
