# 커스텀 DevTools 설계 (CDP 기반)

> 상태: **설계 (구현 전) · architect + critic 리뷰 반영 완료** · 작성/개정 2026-05-30 · 범위: Elements + Console + Network + Sources(전체)
> 리뷰 결과: architect = PROCEED-WITH-FIXES, critic = SOUND-WITH-FIXES. CDP 근본 접근·아키텍처·컨벤션 적합성은 검증됨. must-fix는 §16에 추적.

## 1. 목표

지금 우리는 Chromium의 실제 DevTools UI를 그대로 호스팅한다([electron/browser/devtools.ts](../electron/browser/devtools.ts) — `setDevToolsWebContents` / `openDevTools`). 이걸 **"기능만 가져와서 우리 React UI로 다시 만드는"** 것이 목표다.

왜:
- **상호작용 (단, 핵심 사용 시나리오 = "열린 워크스페이스의 dev 서버로 서빙되는 *자기 앱*을 인스펙트")**. 우리 UI가 구조화된 데이터(실제 nodeId DOM 트리, 진짜 네트워크 엔트리, 콘솔 객체)를 들고 있으면 AI 캡처/composer, patch 시스템과 연결할 수 있다. **이 연결의 강한 형태(라이브 편집→소스 패치)는 인스펙트 대상이 워크스페이스 소스로 역매핑될 때만 성립** — §9 참고. 임의 웹사이트 인스펙트는 read-only/live-only로 여전히 유용.
- **그리드 제약 해소**. 현재 도크는 그리드(분할 화면)에서 no-op로 막혀 있다([devtools.ts:18](../electron/browser/devtools.ts#L18), [layout.ts:46](../electron/browser/layout.ts#L46)). React 패널은 그냥 DOM이라 이 제약이 사라진다(단 멀티-페인은 P5 이후, §13-D2).

## 2. 가능성 결론 — CDP (Chrome DevTools Protocol)

실제 DevTools UI는 내부적으로 **CDP**로 페이지와 통신한다. Electron은 이 프로토콜을 `webContents.debugger`로 그대로 노출한다:

```ts
const dbg = view.webContents.debugger;
dbg.attach('1.3');                                          // CDP 클라이언트로 접속 (멱등 가드 필요)
const res = await dbg.sendCommand(method, params, sessionId); // 명령 → Promise<result>
dbg.on('message', (_e, method, params, sessionId) => …);     // 도메인 이벤트 (sessionId 포함!)
dbg.on('detach', (_e, reason) => …);                         // 크래시/내장DevTools/close 시 자동 발생
dbg.detach();
```

현재 코드에 CDP 사용처는 **0건**(검증: `debugger|sendCommand|CDP` grep). `--remote-debugging-port`/`--inspect` 플래그도 없음(확인). 충돌 없이 신설 가능.

**핵심 제약 (단일 클라이언트, *페이지당*)**: 한 `webContents`에는 CDP 클라이언트가 하나만 붙는다. 내장 DevTools(`setDevToolsWebContents`)·`wc.inspectElement`가 그 클라이언트이므로 **우리 debugger와 동시에 같은 페이지에 못 붙는다**. 단 이는 *페이지당* 제약이지 전역이 아니다 → 둘을 **상호배타로 공존**시킬 수 있다(§11.1 탈출구). 마루데스크 자체 디버깅용 app-level DevTools([main.ts](../electron/main.ts), dev 전용)는 *다른* webContents라 영향 없음.

## 3. 아키텍처 개요

```
┌─ Renderer (React) ───────────────────────────────────────┐
│ features/devtools/                                        │
│   store.ts   ← CDP 세션 상태머신(idle→attaching→attached   │
│                →detached(reason)) + send() 래퍼            │
│   cdp.ts     ← 도메인 enable + 이벤트 라우팅(배치 수신)     │
│   panels/ Elements · Console · Network · Sources          │
│   DevtoolsDock.tsx ← stage 안의 분할 패널 + 드래그 핸들     │
└──────────────┬────────────────────────────────────────────┘
   invoke('devtools:cdp-send', {tabId, sessionId?, method, params})
       → result: {ok:true, result}|{ok:false, error}
   on('devtools:cdp-event', batch: {tabId, sessionId?, method, params}[])
   on('devtools:detached', {tabId, reason})
   invoke('devtools:set-dock-bounds', rect)   // 드래그 중 동기 구동 (§6)
┌──────────────┴─ Main (electron/browser/) ────────────────┐
│ cdp.ts  ← debugger.attach/sendCommand/detach (멱등+가드)   │
│          + on('message') → 배치 릴레이(coalesce)           │
│          + on('detach')/render-process-gone → 세션 리셋    │
│          + method 화이트리스트(정확매칭) + tabId→web탭 검증 │
│ state.ts ← TabRecord.cdpAttached 플래그                    │
│ handlers.ts ← defineHandler('devtools:*')                 │
└────────────────────────────────────────────────────────────┘
```

설계 원칙은 기존 컨벤션 그대로([marudesk-refactor-conventions] 메모리):
- IPC 계약은 `shared/ipc.ts` 단일 출처 (`CHANNELS` + `IpcMap` + `EventPayloadMap` + 컴파일타임 `IpcMapIsComplete` 가드).
- 메인 핸들러는 `defineHandler` + `ipc/validate` 헬퍼만 사용 (raw `ipcMain.handle` 금지).
- `electron/browser/` 패키지 DAG: 신규 `cdp.ts`는 leaf인 `state.ts`만 import(`getHost`로 이벤트 전송), 형제끼리 순환 금지. (리뷰 확인: cycle/위반 없음.)

## 4. 메인 프로세스 — CDP 릴레이 (`electron/browser/cdp.ts`)

새 모듈. `state.ts`(leaf)만 import한다. 공개 함수:

```ts
attachCdp(rec: TabRecord): void   // 멱등 + 동기 attaching 가드(아래). isAttached면 no-op
detachCdp(rec: TabRecord): void   // attach 안돼 있어도 안전(tolerant). 리스너 해제 + cdpAttached=false
sendCdp(rec, method, params, sessionId?): Promise<unknown>  // 화이트리스트 통과 후 dbg.sendCommand
```

`TabRecord`에 상태 추가 ([state.ts:21](../electron/browser/state.ts#L21)):
```ts
cdpAttached?: boolean;
cdpAttaching?: boolean;  // 동기 가드: 거의 동시의 두 cdp-send가 둘 다 !isAttached를 보고
                         //   각각 attach 시도하는 레이스 방지 (devtoolsOpening 패턴과 동일)
// (devtoolsView/devtoolsMode/devtoolsOpening 은 §11.1 정책에 따라 대체/정리)
```

**이벤트 포워딩 — 배치 릴레이 (리뷰 HIGH-3 반영)**: `Network.*`/`DOM.*`/`Debugger.scriptParsed`는 초당 수천 건까지 폭주할 수 있다. 메인이 이벤트마다 IPC 1건 + structured-clone을 하면 메인 프로세스가 포화되어 `browser:set-bounds` 같은 다른 IPC를 굶기고 §6의 드래그 랙을 악화시킨다. 따라서:
- `dbg.on('message', …)` 수신분을 **microtask/`setImmediate` 윈도로 모아 배열로** `devtools:cdp-event`에 보낸다(이벤트당 IPC 1건 ❌).
- `Network.dataReceived` 등 **hot·저가치 메서드는 메인에서 드롭/집계**.
- **응답 body는 이벤트로 절대 안 보냄** — `Network.getResponseBody`로 pull-only (단 body는 캐시 evict 시 사라지므로 "body 없음" 처리 필요).
- 배치 = 도메인 로직이 아니라 transport 계층이므로 관심사 분리를 깨지 않음.

**탭 가시성 정책 (리뷰 M2)**: DevTools를 연 채 다른 탭으로 전환하면 숨은 탭이 계속 이벤트를 흘린다. → 탭 비활성화 시 렌더러가 **고볼륨 도메인(Network/DOM)을 그 탭에 대해 `disable`**, 복귀 시 재-enable (on-nav 재-enable과 같은 메커니즘). detach는 안 함(복귀 시 상태 보존).

**생명주기 (리뷰 HIGH-2 / M1 — "기존 승계" 아님, 신규 작업)**: 코드에 `render-process-gone` 핸들러는 **0건**이다. 따라서 크래시 정리는 새로 만든다:
- **`dbg.on('detach', reason)` = 단일 출처.** 여기서 `rec.cdpAttached=false` + `devtools:detached`({tabId, reason}) 이벤트를 보내 렌더러 세션머신을 `detached`로 보낸다. 내장 DevTools가 어떤 경로로 열려 detach가 와도 동일 처리.
- **`view.webContents.on('render-process-gone'|'destroyed', …)` 추가** ([tabs.ts:98-136](../electron/browser/tabs.ts#L98) webContents 리스너 자리) → `detachCdp(rec)`.
- **close 순서**: `closeTab`/`disposeBrowserView`는 `view.webContents.close()` **전에** `detachCdp` 호출 (기존 "DevTools 먼저 정리" 주석 [tabs.ts:187] 정책과 동일).
- attach: `devtools:open` 또는 첫 `cdp-send` 시 lazy attach. `attach`는 동기 throw일 수 있어 `cdpAttaching` 가드로 레이스 방지. "이미 attached" 예외는 성공으로 흡수.
- 네비게이션: debugger는 살아남지만 enable 도메인·nodeId는 리셋. 렌더러가 **메인 프레임의** `Page.frameNavigated`(서브프레임/광고 iframe nav에 thrash 금지) → `Page.loadEventFired`/문서 생성 이후 도메인 재-enable·`DOM.getDocument` 재조회. ([reapplyInspectOverlay] 철학과 동일.)

**보안 — method 화이트리스트 (정확 매칭 + 명시 deny, 리뷰 HIGH-B)**: 도메인 prefix **정확 매칭**(`startsWith('DOM.')` — `DOMStorage`/`DOMDebugger` 안 샘)으로 허용 도메인을 정한다. 단 **prefix 허용은 도메인 *내부*의 위험 메서드까지 admit하므로**(예: `Network.setCookie`, `Page.navigate`) 그 위험 메서드들을 **deny 셋으로 먼저 차단**한다(allow보다 먼저 평가). 허용 도메인:
```
DOM. · CSS. · Overlay. · Runtime. · Network. · Log. · Page. · Debugger. · Profiler. · Performance.
Target.setAutoAttach · Target.getTargetInfo   // OOPIF/워커(Sources P5)용 — 명시 허용
```
deny(허용 도메인 안에 있어도 차단): `Network.setRequestInterception`/`continueInterceptedRequest`/`set·deleteCookies`/`clearBrowserCookies`/`clearBrowserCache`/`setUserAgentOverride`/`setExtraHTTPHeaders`/`setBlockedURLs`/`replayXHR`, `Page.navigate`/`navigateToHistoryEntry`/`setDownloadBehavior`/`setBypassCSP`/`setInterceptFileChooserDialog`/`crash`/`close`. 도메인째 미허용(자동 차단): `Browser.*`·`Fetch.*`·`Input.*`·`Emulation.*`·`Storage.clearDataForOrigin`·`Target.createTarget`/`attachToTarget`. `tabId`는 `getTab(id)?.kind==='web' && rec.view`로 검증, 아니면 거부. (deny-list 선택 이유: P5가 `Network.emulateNetworkConditions`/`setCacheDisabled`를 필요로 해 도메인째 method-allow보다 마찰이 적음 — 신뢰 렌더러 모델 하의 defense-in-depth.)

> 참고: `Runtime.evaluate`는 페이지 컨텍스트에서 임의 JS를 돌린다. inspect 오버레이는 **권한차단 별도 파티션**(`persist:inspect-target`, [tabs.ts:226])에서 도므로 신뢰 모델이 *유사하지만 동일하진 않다*. "사용자가 자기 페이지를 디버깅"하는 맥락이라 허용하되, 릴레이는 메인에만 두고 원격 콘텐츠에 raw `sendCommand`를 노출하지 않는다. P0 스파이크에서 **attach 상태에서도 일반 페이지 입력(클릭/타이핑/F12)이 정상인지** 확인.

## 5. IPC 계약 추가 (`shared/ipc.ts`)

새 `devtools` 도메인. **결정: `browser:toggle-devtools`는 제거하고 `devtools:open`/`close`로 교체**(P0 산출물이 IPC 계약이라 모호함 제거). 진입점 3곳을 새 채널로 라우팅: F12([Shell.tsx:33](../src/views/Shell.tsx#L33)) + 렌치([BrowserCanvas.tsx:158](../src/features/browser/BrowserCanvas.tsx#L158)) + 페이지 포커스 in-page F12(메인 `before-input-event`, [tabs.ts:122](../electron/browser/tabs.ts#L122)).

```ts
// CHANNELS 에 추가
devtools: [
  'devtools:open',            // 활성 web 탭에 attach + 패널 표시
  'devtools:close',           // 패널 숨김 (detach 정책은 §4)
  'devtools:cdp-send',
  'devtools:set-dock-bounds', // 드래그 중 web view 동기 축소 (§6, HIGH-1)
],

// IpcMap 에 추가
'devtools:open':  { args: []; result: boolean };   // web 탭 아니면 false
'devtools:close': { args: []; result: boolean };
'devtools:cdp-send': {
  args: [payload: { tabId: string; sessionId?: string; method: string; params?: object }];
  // 에러를 throw로 흘리면 "명령 실패"(복구가능)와 "세션 죽음"(재attach)을 구분 못함 → 봉투로:
  result: { ok: true; value: unknown } | { ok: false; error: string };
};
'devtools:set-dock-bounds': { args: [rect: Rect | null]; result: void };  // null=드래그 끝, set-bounds 흐름 복귀

// EventPayloadMap + EVENT_CHANNELS 에 추가
'devtools:cdp-event': { tabId: string; items: { sessionId?: string; method: string; params: unknown }[] }; // 배치
'devtools:detached':  { tabId: string; reason: string };
```

`sessionId?`는 P0~P4에서 root 세션만 쓰더라도 **지금 계약에 넣는다**(리뷰 MED-1: P5 워커/OOPIF에서 `Target.setAutoAttach({flatten:true})` 하는 순간 모든 명령/이벤트가 sessionId로 스코프됨 → 나중에 넣으면 계약 파괴). `IpcMapIsComplete` 가드가 누락을 컴파일 에러로 잡고, preload 화이트리스트는 자동 파생([preload.ts:9](../electron/preload.ts#L9)).

## 6. 레이아웃 / 마운트 — React 도크

**핵심 메커니즘 (정적 상태)**: 단일뷰에서 [BrowserCanvas.tsx:47-58](../src/features/browser/BrowserCanvas.tsx#L47)이 자기 페인트 영역을 측정해 `browser:set-bounds`를 푸시한다. DevTools React 패널을 **BrowserCanvas 측정 영역과 형제 flex item**으로 넣으면 web view는 `ResizeObserver`→`set-bounds`로 자동 축소된다.

> ⚠️ **드래그 리사이즈는 공짜가 아니다 (리뷰 HIGH-1).** 네이티브 `WebContentsView`는 React DOM *위에* 합성된다([tabs.ts:138] `addChildView`). 도크 가장자리를 드래그하면 React 패널은 즉시 리페인트되지만 네이티브 web view는 `getBoundingClientRect`→IPC→`setBounds` 왕복 뒤에야 따라와, 매 프레임 겹침/틈이 출렁인다. 대책 (P0에서 실측 후 택1):
> 1. 드래그 핸들에서 **`devtools:set-dock-bounds`로 web view bounds를 동기 구동**(ResizeObserver 기다리지 않음), 또는
> 2. 드래그 동안 `setBrowserVisible(false)`로 web view를 **불투명 오버레이로 덮고** drop에서 스냅(이 오버레이 패턴은 [layout.ts:177-198]에 이미 존재 — composer 오버레이용).
>
> 즉 "새 레이아웃 IPC 불필요"는 정적 상태에서만 참. **P0 스파이크는 정적 도크가 아니라 드래그 가능한 도크 + 실제 페이지로 이 seam을 반드시 검증한다.**

이 결과로:
- [layout.ts](../electron/browser/layout.ts)의 `devtoolsView` 처리 부위 **전부**(§10 정리에서 ~7곳 열거)와 [devtools.ts](../electron/browser/devtools.ts)는 §11.1 정책에 따라 정리.
- 도크 위치는 전체 DevTools 공유 단일 위치(§13-D1), 토글 right/bottom/popup, 설정 영속.
- 그리드 모드: §13-D2 (v1은 no-op + 토스트).

## 7. 패널 ↔ CDP 도메인 매핑

| 패널 | 활성화 | 데이터 조회 | 이벤트 | 변경(편집) |
|---|---|---|---|---|
| **Elements** | `DOM.enable`,`CSS.enable`,`Overlay.enable` | `DOM.getDocument`, `DOM.requestChildNodes`, `DOM.getOuterHTML`, `CSS.getMatchedStylesForNode`, `CSS.getComputedStyleForNode`, `CSS.getInlineStylesForNode` | `DOM.documentUpdated`, `DOM.childNodeInserted/Removed`, `DOM.attributeModified/Removed` | `CSS.setStyleTexts`, `DOM.setAttributeValue`, `DOM.setOuterHTML` |
| **요소 피커** | `Overlay.setInspectMode({mode:'searchForNode'})` | — | `Overlay.inspectNodeRequested` → backendNodeId → `DOM.pushNodesByBackendIdsToFrontend` | `Overlay.highlightNode`(호버 하이라이트, 박스모델 색상) |
| **Console** | `Runtime.enable`, `Log.enable` | `Runtime.getProperties`(객체 트리 확장) | `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Log.entryAdded` | `Runtime.evaluate`(REPL, `objectGroup`/`awaitPromise`) |
| **Network** | `Network.enable` | `Network.getResponseBody`(캐시 evict 시 실패→"body 없음" 처리), `Network.getRequestPostData` | `requestWillBeSent`, `responseReceived`, `loadingFinished`, `loadingFailed`, `dataReceived`(집계) | (옵션) `Network.setCacheDisabled`, `emulateNetworkConditions` |
| **Sources** | `Debugger.enable`, `Runtime.runIfWaitingForDebugger` | `Debugger.getScriptSource`, `Debugger.searchInContent` | `Debugger.scriptParsed`, `Debugger.paused`, `Debugger.resumed` | `Debugger.setBreakpointByUrl`, `removeBreakpoint`, `pause`, `resume`, `stepOver/Into/Out`, `evaluateOnCallFrame`, `setPauseOnExceptions` |

**`Overlay.setInspectMode`의 의미**: Chromium이 네이티브 하이라이트 + "클릭해서 선택"을 직접 그리고 선택 시 `Overlay.inspectNodeRequested`를 쏜다. 즉 [inspect-overlay.ts](../electron/inspect-overlay.ts)의 손수짠 selector 빌더·mousemove·box 오버레이(152줄)를 **CDP 네이티브로 대체** 가능, margin/padding 박스모델까지 공짜.

> 단, 기존 inspect는 **AI 캡처**라는 출시된 별도 기능(composer로 흘러감, `browser:capture` 이벤트). 초기엔 둘을 **분리 유지**(출시 동작 보존)하고, 나중에 CDP 피커가 AI 캡처를 흡수할지 별도 결정.

## 8. 렌더러 — `features/devtools/`

```
features/devtools/
  store.ts   ← zustand. 탭별 세션 상태머신 idle→attaching→attached→detached(reason),
               openPanel, byDomain slices. detached 수신 시 세션 폐기 + 다음 open에 재attach.
  cdp.ts     ← send(method,params,sessionId?) = invoke('devtools:cdp-send',…) → {ok}|{error} 해석
               + on('devtools:cdp-event') 배치 구독 → method별 슬라이스 라우팅
               + on('devtools:detached') → 세션머신 리셋
               + enableDomains()/onMainFrameNavigated()/onTabHidden() 재-enable·pause 헬퍼
  DevtoolsDock.tsx ← 패널 탭바(Elements/Console/Network/Sources) + 드래그 핸들(§6)
  panels/  ElementsPanel · ConsolePanel · NetworkPanel · SourcesPanel
  components/ DomTree · StyleEditor · ConsoleRow · NetworkTable · CallStack …
```

**id 상관관계 불필요**: `debugger.sendCommand`가 이미 `Promise<result>`라 명령/응답 매칭은 공짜(root 세션). 렌더러 클라이언트는 **이벤트 라우팅·도메인 enable 관리·세션 상태머신**을 담당. **에러 UX**: `{ok:false,error}`는 패널에 비차단 에러 행으로 표시하고 패널을 비우지 않는다; `devtools:detached`만 세션을 리셋한다.

도크 마운트는 [registry.tsx](../src/features/tabs/registry.tsx)의 `tabKinds`가 아니라 **stage 레벨**(BrowserCanvas 옆) 조건부 렌더 — DevTools는 탭이 아니라 페이지에 붙는 도크(탭 kind면 페이지를 동시에 못 봐 목적이 깨짐).

## 9. "상호작용" 통합 훅 — 스코프 명확화 (리뷰 C2/C3)

이 프로젝트의 명분이지만 가장 과소설계였던 부분. 두 훅의 **난이도가 전혀 다르다**:

**(A) 노드 → 캡처/composer (보편적, 단기 승리)**: 어떤 페이지든 선택 노드를 composer 컨텍스트로 전달. 단, CDP 노드는 `nodeId`/`getOuterHTML`/computed style(CSS 속성 배열)을 주는데 기존 `Capture`([shared/capture.ts])는 `{selector,tagName,text,attributes,rect,url}` 평면 타입이라 **outerHTML/computed style을 담을 칸이 없다**. → P4에서 **`Capture`에 `outerHTML?`/`computedStyle?` 옵션 필드 추가**(파급: `workspace:rank`의 `CaptureInput`, `shared/composer.ts`, context UI — 옵션이라 호환). CDP노드→`Capture` 어댑터 필요.

**(B) 라이브 CSS 편집 → 소스 패치 (어려움, *스코프 한정*)**: `patch`는 `{path,oldString,newString}`로 **워크스페이스 파일**을 고친다([shared/patch.ts]). 그런데 렌더된 CSS는 번들 출력·CSS-in-JS·인라인 `<style>`·원격 스타일시트일 수 있어 **워크스페이스 파일/oldString에 내재적 매핑이 없다**. 무리하게 일반화하면 5단계 투자 후 명분이 붕괴.
- **결정**: (B)는 **"열린 워크스페이스의 dev 서버가 서빙하는 자기 앱"을 인스펙트할 때, 스타일시트가 소스맵으로 워크스페이스 파일에 역매핑되는 경우로 한정**. 번들/원격/CSS-in-JS 편집은 **live-only**(패치 제안 안 함, 페이지에만 적용).
- (B)는 P4의 한 줄 부속이 아니라 **P0.5 타당성 스파이크**(§10)로 *먼저* 1건 왕복을 증명한 뒤 약속한다. 스파이크 실패 시 (B)는 stretch로 강등, (A)만으로도 제품 가치 성립.

기타: Network 응답 → composer 첨부(A류, 용이). 멀티-페인 동시 관찰은 P5 이후(§13-D2).

## 10. 단계 (마일스톤)

| 단계 | 내용 | 수용 기준 / 비고 |
|---|---|---|
| **P0 플럼빙** | `cdp.ts` attach/send/detach(+크래시 detach: `render-process-gone`) + `devtools:*` IPC(+`set-dock-bounds`, sessionId, 에러봉투) + 렌더러 세션머신 + **드래그 가능한** 빈 도크 + `DOM.getDocument` 트리 덤프 | **수용 기준**: (1) 실제 페이지로 attach→트리 덤프 end-to-end, (2) **드래그 리사이즈 시 web view seam 출렁임 허용범위 검증**(§6, 안되면 set-dock-bounds/덮기 적용), (3) attach 상태에서 페이지 입력 정상, (4) 탭 닫기/크래시 후 좀비 디버거 없음(attach/detach 카운트), (5) about:blank 말고 실제 페이지로 검증 |
| **P0.5 통합 타당성 스파이크** | 노드→`Capture` 1건 왕복(A) + dev서버 서빙 자기 앱에서 인라인스타일 편집→`patch:preview` 1건(B) | §9 명분을 *조기* 검증. (B) 실패 시 스코프 축소를 문서에 확정 |
| **P1 Elements** | DOM 트리(lazy `requestChildNodes`) + 매칭/계산 스타일(읽기) + `Overlay` 피커·하이라이트 | 단독 가치(인스펙터) |
| **P2 Console** | `consoleAPICalled`/`exceptionThrown` 스트림 + `Runtime.evaluate` REPL + 객체 트리 | |
| **P3 Network** | 요청 테이블 + 타이밍 + 헤더 + `getResponseBody`(없음 처리) | |
| **P4 Elements 편집 + 통합** | `setStyleTexts`/`setAttributeValue` 라이브 편집 + (A) 캡처 훅(`Capture` 확장) + (B) 한정 패치 훅 | **여기서 프로젝트 thesis가 검증됨** — P1~P3는 단독 가치, P4가 명분 |
| **P5a Sources(transpiled)** | scriptParsed 트리 · 소스 뷰 · BP · pause/resume/step · 콜스택/스코프 · 조건부 BP. `Target.setAutoAttach`로 워커/OOPIF | **가장 큼** |
| **P5b Sources(원본 복원)** | 소스맵 해석→원본 트리 · BP/일시정지 위치 생성↔원본 양방향 매핑 · 인라인 `data:`(쉬움) vs 외부 `.map`(아래) | §13-D3. 외부 `.map`은 렌더러 `fetch`가 **호스트 CSP `connect-src`에 막힘**([main.ts:42]) → **메인이 web view 세션으로** fetch하거나 `Page.getResourceContent`로 CDP 경유 |
| **정리** | `devtoolsView` 부위 ~7곳 제거([layout.ts] `applyBoundsToActive`/`applyPaneBounds`/`hideTab`/`showTab`/`setBrowserVisible` + [state.ts] 필드 + [devtools.ts]) · **`inspectElementAt`의 `wc.inspectElement`를 CDP `Overlay`로 재배선**(정합성, 아래) · 컨텍스트메뉴 "Inspect" 재배선 · 설정 마이그레이션 · 내장 탈출구 처리(§11.1) | 횡단 |

> **정합성 주의 (리뷰 MED-2)**: [devtools.ts:72-93]의 `inspectElementAt`은 `wc.inspectElement`로 **내장 DevTools를 연다** → 우리 debugger가 붙은 페이지에서 호출되면 단일클라이언트 위반으로 한쪽이 실패. 이건 "정리"가 아니라 **정합성 버그**라 P1(피커) 도입과 함께 재배선/삭제해야 한다.

## 11. 리스크 & 결정 사항

1. **단일 CDP 클라이언트 + 탈출구 (리뷰 M6)** — 페이지당 제약이므로 *전역 제거*가 강제되진 않는다. **parity 도달 전까진 내장 DevTools를 도크 옵션 `'chrome'`(우리 CDP를 detach 후 진짜 DevTools popup)으로 유지** → P1~P4 동안 사용자가 Network 스로틀링·기기 에뮬레이션·소스맵(P5b 전) 등을 잃지 않게. `layout.ts`의 `devtoolsView` 분기 삭제는 정리 단계대로 하되 popup 탈출구는 parity까지 생존. parity 기준 = §14 비목표로 명시.
2. **Sources는 거대하다** — P5a/P5b 분리, P1~P4로 단독 가치 먼저.
3. **재-enable on nav** — **메인 프레임** `Page.frameNavigated`→`loadEventFired`/문서 생성 후 재-enable·재조회(서브프레임 thrash 금지). 누락 시 빈 패널(silent).
4. **detach 누수 — 신규 작업** (리뷰 HIGH-2/M1): `render-process-gone`/`destroyed` 핸들러는 현재 0건 → 새로 등록. `on('detach')`가 단일 출처, close 전에 detach, 멱등 attach + tolerant detach + `cdpAttaching` 가드.
5. **이벤트 볼륨 + 백그라운드 탭** (리뷰 HIGH-3/M2): 메인 배치 릴레이 + hot 드롭 + 숨은 탭 도메인 pause. body는 pull-only.
6. **`chrome-devtools-frontend` 임베드 유혹** — 거부. raw CDP + 우리 React 패널.
7. **설정 마이그레이션 — 메커니즘 명시 (리뷰 C1)**: `DevtoolsDock='side'|'popup'`→`'right'|'bottom'|'popup'`(+탈출구면 `'chrome'`). `sanitizeSettings`의 `asEnum`은 **remap이 아니라 fallback**([settings.ts:162])이라 persisted `'side'`는 새 기본값으로 떨어진다 — 새 기본값을 `'right'`로 둔 덕에 *우연히* 맞을 뿐. → 이걸 "처리됨"으로 적지 말 것. **택1: (a)** "새 기본값=레거시 타깃이라 fallback으로 충분" 명시 + 테스트 `sanitizeSettings({devtools:{defaultDock:'side'}}).devtools.defaultDock==='right'`, **또는 (b)** `version` 범프 + load 시 명시 remap. `DOCKS`([settings.ts]) + `DOCK_OPTIONS`([SettingsView.tsx:28])를 lockstep 갱신(안 그러면 드롭다운에 `bottom` 없음).
8. **inspect 기능 중복** — AI 캡처(출시됨)와 CDP 피커 분리 유지.
9. **dev 리로드 불일치** — Vite HMR이 렌더러만 재마운트하면 메인 `cdpAttached`는 true인데 새 스토어는 detached로 시작 → 불일치. 렌더러 mount 시 메인에 현재 attach 상태를 질의하거나, `devtools:open`을 항상 멱등 재동기화로.

## 12. 검증

- **타입**: `IpcMapIsComplete` 가드. (함정: WIP 트리에서 `tsc -b`는 stale `.tsbuildinfo`로 phantom 에러 → `tsc -b --force` 또는 `tsc -p tsconfig.electron.json --noEmit`.)
- **단위**: `cdp.ts` 릴레이를 `webContents.debugger` 스텁으로 — 화이트리스트 정확매칭/`tabId` 검증/배치 포워딩/`open→close→open`·크래시 후 **중복 attach 없음**(attach·detach 카운트, 리뷰 L3) 테스트. 설정 마이그레이션 테스트(§11.7).
- **e2e**: 실제 페이지 CDP 구동은 Playwright로 까다로움 → 도크 열림/전환/트리 렌더 렌더러 DOM 스모크 + 수동 GUI 스모크(Elements 선택, Console eval, Network 기록, BP, **드래그 seam**, 크래시 후 재open).
- 각 단계: 빌드 → 별도 `code-reviewer` 패스(HIGH/MED 수정) → 빌드 클린 → 스모크.

## 13. 해결된 결정 (2026-05-30)

- **D1 — 도크 위치**: 전체 DevTools 공유 단일 위치(Chrome 멘탈모델), `right`/`bottom`/`popup` 토글, 영속. **기본값 `right`**. 근거: 넓은 IDE 창 + 첫 패널 Elements의 DOM 트리는 세로로 길어 full-height 우측이 편함. *반론(critic): Chrome 기본은 bottom이고 Network/Console은 가로폭을 원함 — 채택하되 bottom은 토글 한 번이고 기억되므로 수용.* 패널별 위치는 미채택(전환 시 화면 튐).
- **D2 — 그리드 인스펙터**: 진짜 페인별 멀티세션은 **P5 이후로 연기**. **v1 그리드에서 F12/렌치 = no-op + "그리드 종료 후 DevTools 사용" 토스트** (리뷰 M3 반영: 당초 "포커스 페인을 단일뷰로 승격"은 `clearBrowserPaneBounds`가 그리드를 통째 파괴하고 복구 경로가 없어 *더* 당황스럽다 — 데이터 손실은 없으나 사용자 레이아웃 파괴). 승격+복구는 후속 옵션.
- **D3 — Sources 원본 복원**: **함**. 소스맵 해석→원본 표시 + BP/일시정지 위치 양방향 매핑. CDP는 소스맵 자동해석 안 하므로 렌더러 `source-map` 파싱. **외부 `.map` 페치는 호스트 CSP에 막히므로 메인/CDP 경유**(§10 P5b). 범위 커서 P5b 분리.

## 14. 비목표 (Non-Goals, v1) — 리뷰 M5

커스텀 DevTools는 한동안(혹은 영영) 실제 Chrome DevTools의 다음을 갖지 않는다. **내장 DevTools 탈출구(§11.1)를 parity 전까지 유지하는 이유.**
- 기기/반응형 **에뮬레이션** (웹개발에서 매우 흔함 — 제거 전 사용자 경고 필수)
- Lighthouse, 커버리지, **Performance/Memory 프로파일러**, JS 프로파일러 UI
- Accessibility 트리, Application/Storage 패널(쿠키/IndexedDB/캐시 편집), Security 패널, Animations 인스펙터
- 확장(extension) DevTools 패널

"parity 기준"(=내장 탈출구를 제거해도 되는 시점)은 위 목록 중 **에뮬레이션과 Network 스로틀링이 우리 UI에 들어오는 때**로 잠정 정의. 그 전까지 `'chrome'` 옵션 유지.

## 15. 성공 기준 (thesis 검증)

단순 parity("Elements 선택 가능, Console eval 됨")가 아니라 **상호작용 명분**을 직접 재는 기준:
- 노드를 Elements에서 선택하면 **composer 컨텍스트에 outerHTML/computed style과 함께** 나타난다(A).
- dev 서버가 서빙하는 자기 앱에서 인라인 스타일을 편집하면 **워크스페이스 파일에 대한 유효한 `patch:preview`가 생성**된다(B, 한정 스코프).
- 크래시/네비게이션/탭 전환을 가로질러 **좀비 디버거·빈 패널·이벤트 누수가 없다**.

## 16. 리뷰 must-fix 추적 (P0 착수 전/중)

| # | 출처 | 항목 | 반영 위치 | 상태 |
|---|---|---|---|---|
| 1 | arch HIGH-1 | 드래그 리사이즈 web view 랙 | §6, §5 `set-dock-bounds`, §10 P0 수용기준 | 반영 |
| 2 | arch HIGH-2 / crit M1 | 크래시 detach는 신규(승계 아님) | §4 생명주기, §11.4, §10 P0 | 반영 |
| 3 | arch HIGH-3 / crit M2 | 무필터 포워딩 백프레셔 + 숨은 탭 | §4 배치/가시성, §11.5 | 반영 |
| 4 | crit C2 | (B) 라이브CSS→패치 매핑 과소설계 | §1, §9(B) 스코프 한정 + §10 P0.5 | 반영 |
| 5 | crit C3 | `Capture`가 outerHTML/스타일 못 담음 | §9(A), §10 P4 | 반영 |
| 6 | arch MED-1 | `sessionId` 누락 + `Target` 모순 | §5 계약, §4 화이트리스트 | 반영 |
| 7 | arch MED-2 | `inspectElementAt`=내장DevTools=단일클라 위반 | §10 정리(정합성), P1 동반 | 반영 |
| 8 | crit C1 | 설정 마이그레이션 우연·미명시 | §11.7 + 테스트 | 반영 |
| 9 | crit M6 | parity 전 제거=회귀 → 탈출구 | §11.1, §14 | 반영 |
| 10 | crit M5 | 비목표 부재 | §14 | 반영 |
| 11 | crit M3 / D2 | 그리드 F12가 레이아웃 파괴 | §13-D2 (no-op+토스트) | 반영 |
| 12 | arch MED-4 | 외부 소스맵 fetch CSP/파티션 | §10 P5b | 반영 |
| 13 | arch MISS / crit | 에러 봉투, body 수명, nav 프레임, 화이트리스트 정확매칭, tabId 가드 | §4, §5, §7 | 반영 |

## 17. 코드 리뷰 반영 — P0 메인-프로세스 foundation (2026-05-30)

메인-프로세스 기반(IPC 계약 + `cdp.ts` + state + handlers + tabs 배선) 구현 후 `code-reviewer` 패스. **verdict = SHIP-WITH-FIXES**, `tsc -b --force` + `eslint` 클린. 적용 내역:
- **HIGH-A** 틱당 버퍼 무제한(배칭은 IPC *빈도*만 제한, *양*은 무제한 → 거대 structured-clone) → `MAX_ITEMS_PER_TICK`(3000) 캡 + 초과분 `dropped` 카운트를 `devtools:cdp-event`에 실어 렌더러가 "N dropped" 표시. [완료]
- **HIGH-B** prefix 화이트리스트가 도메인 내 위험 메서드 admit(문서 §4 "차단" 주장과 불일치) → 명시 `BLOCKED_METHODS` deny 셋을 allow보다 먼저 평가(§4 reconcile). [완료]
- **MED-A** 명시 detach 후 trailing 메시지가 끊긴 세션으로 flush 가능 → `'message'` 리스너에 `if(!cdpAttached) return` 게이트. [완료]
- **MED-B** open/close가 active-tab 기준인데 cdp-send는 tabId 기준 → open/close도 `{tabId}` payload로 통일(4채널 동일 소유권 모델). [완료]
- **MED-C** `.detach()`가 `'detach'`를 쏘는지 가정에 의존 → `detachCdp`가 `.detach()` *전에* `cdpAttached=false`, `'detach'` 핸들러는 `!cdpAttached`면 self-suppress ⇒ 양쪽 Electron 동작에 견고. ⚠️ **P0 스모크에서 attach==detach 카운트 + 사용자 close 시 `devtools:detached` 0건 확인**(이제 load-bearing 아닌 확인용).
- 견고 확인: `cdp.ts` leaf-only import, `cdpAttaching` 레이스 가드, `detachCdp` 예외 안전, 에러봉투 경계, `validate` 컨벤션 준수, 4개 must-fix(HIGH-2/HIGH-3/MED-1/봉투+tabId) 구현 확인.
- 이월: **HIGH-C** `Runtime.evaluate` confused-deputy — 렌더러 PR에서 page-originated input을 `cdp-send`로 흘리지 않도록 확인(현재 preload 모델에선 안전). MED-D(host 부재 시 버퍼 드롭)·LOW-1~3은 P0 스모크/렌더러 단계.

## 18. 렌더러 dock + P1–P3 + 사이드도크 제거 구현 (2026-05-30)

P0 메인 foundation 위에 **렌더러 커스텀 DevTools 전체 + 호스팅 사이드도크 제거**를 구현. `tsc`(app+electron)·`eslint`·`vite build`·Playwright e2e 9/9 그린.

**신규 `src/features/devtools/`**
- `types.ts` — 소비하는 CDP 와이어 타입(DOM/CSS/Runtime/Network)만.
- `cdp.ts` — `cdpSend`/`cdpTry`: `{ok,value}|{ok,error}` 봉투 언랩 → value-or-throw(`CdpError`).
- `store.ts` — zustand. dock UI(open/side/size/panel) + 세션머신(idle→attaching→attached→detached) + **epoch 세대 가드**(rebind 레이스 방지) + Elements/Console/Network 슬라이스 + `ingestBatch`(틱당 1회 immutable clone, 메서드별 라우팅) + **`Page.frameNavigated`(메인프레임만) → 재-enable·재조회**.
- `useDevtoolsEvents.ts` — `devtools:cdp-event`(bound 탭 필터)/`detached`/`toggle`/`inspect-at` 구독 + 활성 web 탭으로 rebind + HMR mount 재동기화.
- `DevtoolsDock.tsx` — 드래그 스플리터가 `devtools:set-dock-bounds`로 web rect 동기 푸시(매 프레임 wrapper 재측정 → HIGH-1 seam). right/bottom 토글, dropped 표시, detached 배너+Reconnect.
- `panels/` — Elements(DomTree lazy `requestChildNodes` + StylesPane matched/inline/computed + `Overlay` 피커/하이라이트), Console(스트림+`Runtime.evaluate` REPL+`RemoteValue` 1-레벨 확장), Network(테이블+헤더+`getResponseBody` on-demand).
- 토스트: `src/lib/toast.ts` + `src/components/ToastHost.tsx`(그리드 F12 가드 피드백).

**배선**: F12([Shell.tsx])·렌치([BrowserCanvas.tsx])·인페이지 F12(메인 before-input-event → `devtools:toggle` 이벤트)·컨텍스트메뉴 Inspect(메인 → `devtools:inspect-at` 이벤트)가 전부 store 액션으로 funnel. dock는 BrowserCanvas의 stage flex 형제로 마운트(web 단일뷰 한정) → ResizeObserver가 web view 축소.

**제거(§10 cleanup 완료)**: `setDevToolsWebContents` 사이드도크 전부. `devtools.ts`는 chrome 팝업 탈출구만(`openChromeDevtools`/`closeChromeDevtools`/`toggleChromeDevtools`, CDP detach 선행). `state.ts` devtoolsView/Mode/Opening 제거(+`chromeDevtoolsOpen`). `layout.ts` devtoolsView 분기 전부 제거. `browser:toggle-devtools` 채널 제거. `inspectElementAt`(단일클라 위반) 제거 → 컨텍스트메뉴는 CDP 경유. **유지**: 설정 `'chrome'` 탈출구(§11.1/§14).

**IPC 추가**: `devtools:open-chrome`(invoke) + `devtools:toggle`/`devtools:inspect-at`(event). **설정**: `DevtoolsDock`=`'right'|'bottom'|'chrome'`, 기본 `'right'`; 레거시 `'side'`/`'popup'`은 asEnum fallback→`'right'`(§11.7(a)).

**code-reviewer(opus) 패스 — REQUEST CHANGES, 전부 수정**: HIGH-1(nav 재-enable 누락 → `Page` enable + `frameNavigated` 메인프레임 핸들 + 슬라이스 clear)·HIGH-2(rebind 레이스 → epoch 가드 + close-before-open await)·MED-2(open 실패 stranded → epoch로 항상 리셋)·MED-3(드래그 stale rect → 매 프레임 재측정)·MED-5(inspect-at 좌표 stale → dock 표시 *전에* 노드 해석)·MED-6(HMR mount 재동기화). 화이트리스트·`ingestBatch` 불변성·chrome 단일클라·그리드 가드는 리뷰에서 correct 확인.

**e2e** `e2e/devtools.spec.ts`: (1) 비-web 탭 F12 no-op, (2) web 탭 dock 열기 → 실 CDP `DOM.getDocument` 트리 렌더 + Console 패널 전환(실제 attach end-to-end).

**미완(의도적 phasing)**:
- **P4** — Elements 라이브 편집(`CSS.setStyleTexts`/`DOM.setAttributeValue`) + (A) 노드→`Capture` 훅(`shared/capture.ts`에 `outerHTML?`/`computedStyle?` 추가) + (B) 라이브CSS→`patch:preview`(소스맵 역매핑 한정). **thesis(§15) 검증 단계 — 미착수.**
- **P5a/P5b** — Sources(transpiled 디버깅 + 소스맵 원본복원). 최대 규모, 미착수.
- 백그라운드 탭 고볼륨 도메인 pause(§4 M2) — 현재는 rebind 시 detach로 대체.
- 설정 마이그레이션 단위테스트(§11.7/§12) — vitest 도입 후 `shared/settings.test.ts`로 완료(레거시 `side`/`popup` → `right` fallback 검증).
- 나머지 리뷰 LOW(리다이렉트 체인, console.group, base64 body, size-per-orientation)는 v1 수용.

## 19. P4 — 라이브 편집 + 통합 훅 A/B 구현 (2026-05-30)

P1~P3 dock 위에 **프로젝트 thesis(§15) 검증 단계**를 구현. `tsc`(app+electron)·`eslint`·`vite build`·Playwright e2e **10/10** 그린. `code-reviewer`(opus) 패스 = **COMMENT(approve-with-nits, HIGH 0/MED 2/LOW 4)**, MED·해당 LOW 전부 반영.

**(A) 노드 → Capture (보편적, §9-A)** — 완료.
- `shared/capture.ts` `Capture`에 `outerHTML?`/`computedStyle?` 옵션 추가(레거시 inspect 오버레이 캡처는 미설정 → 전 소비자 호환). 파급: `shared/composer.ts` `CapturePayload` + composer `toPayload`, `electron/llm.ts` `isCapturePayload`(옵션 검증) + `buildUserMessage`(per-capture 블록에 `computed style:` 줄 + ```html``` outerHTML 펜스, `escapeFence`로 주입 차단, `MAX_OUTER_HTML_CHARS=2000` 프롬프트 클립).
- 신규 `src/features/devtools/capture.ts`: CDP노드→`Capture` 어댑터(조상 기반 selector, 평면 attrs→record, 큐레이트 computed 27키+값 200자 클립, `DOM.getBoxModel` border quad→rect, `DOM.getOuterHTML` 8000자 클립). store `captureSelected()` → `useWebPageStore.addCapture` + 토스트. UI: Elements 툴바 "Add to AI context"(Sparkles, 선택 시 활성).
- `CaptureInput`/`rankFiles`는 **미변경**(attributes의 id/class/testid가 강신호, computed는 노이즈) — 옵션 필드라 호환.

**(라이브 편집)** — 완료.
- `CSS.setStyleTexts`: StylesPane 값 클릭→인라인 편집. author `origin:'regular'` + styleSheetId + range 있는 규칙만 editable(+ inline `element.style`), user-agent read-only. 편집 후 `selectNode` 재조회로 range 갱신.
- `DOM.setAttributeValue`: DomTree 속성 값 더블클릭→인라인 편집(단일클릭=선택 보존, pointer/key stopPropagation). `DOM.attributeModified` 이벤트가 트리 자동 갱신.
- 화이트리스트 변경 불필요(`CSS.`/`DOM.` prefix 통과, BLOCKED 아님 — 리뷰 확인).

**(B) 라이브 CSS → 워크스페이스 패치 (스코프 한정, §9-B)** — 완료(범위 한정).
- **신규 IPC 없음**: 기존 `patch:preview`/`patch:apply` 재사용. fs-safe `resolveWorkspacePath` + oldString 유일성 검사가 **타당성 게이트**.
- 메커니즘: `CSS.styleSheetAdded` 헤더 추적(store `styleSheets` Map, `ingestBatch` clone-on-write) → 편집 시 `CSS.getStyleSheetText`를 ground truth로 블록 단위 `PatchOp` 생성(`css-source.ts` `computeBlockEdit`: line/col→offset, 포맷 보존 minimal splice; range 없으면 `rebuildStyleText` 폴백) → `resolveStyleSheetSource`(same-origin 게이트 + pathname strip)로 워크스페이스 경로 매핑 → `patch:preview` 검증 → 성공 시 StylesPane "Save to source" 배너(`patch:apply`). 매핑/검증 실패 시 **조용히 live-only**.
- **스코프 해석(중요)**: 현재는 **Layer 1 = same-origin 서빙 author 스타일시트의 URL pathname이 워크스페이스 파일을 미러**하는 경우(정적/`<link>` CSS, dev 서버가 실파일 서빙)만 소스 매핑. **Vite의 JS주입 `<style>`(import한 CSS)은 통상 sourceURL이 없어 live-only로 강등** — §9-B의 "소스맵 역매핑" 중 가장 단순/견고한 부분만 채택. **미채택(후속)**: owner-node `data-vite-dev-id` 해석, 외부 `.map` 파싱(P5b급). 이로써 thesis(§15-B "유효한 patch:preview 생성")는 서빙-파일 케이스에서 성립하고, 어려운 주입-스타일 케이스는 명시적 future work.

**code-reviewer 반영**:
- MED-1: `_offerSourcePatch`가 `patch:preview` await 후 `selectedId`만 재확인 → `tabId`도 캡처/재확인(리바인드 후 cross-tab "Save" 방지).
- MED-2: `editStyleProperty`가 `setStyleTexts` await 후 `selectNode` 전에 `tabId`+`selectedId` 재확인(stale nodeId가 새 문서에 쓰이는 1-tick 창 차단).
- LOW-1: 블록 같은 곳 **2회 편집-전-저장**은 2번째 oldBlock이 디스크와 불일치 → live-only 강등(저장 후 편집 권장). 코드 주석 + 본 절 문서화.
- LOW-2: computed 값 개별 길이 200자 클립(거대 `url(data:…)` 방어).
- LOW-3(traversal 조기 차단은 fs-safe가 권위)·LOW-4(nav 직후 헤더 재수신 전 짧은 live-only 창)는 correct/수용 — 무조치.

**알려진 한계(v1 수용)**: 위 Layer-1 스코프, 멀티편집-전-저장, 편집 커밋 시 `selectNode`가 styles를 잠깐 비워 "Loading styles…" 깜빡임(정확성 무관).

**e2e**: `devtools.spec.ts`에 hook A 케이스 추가(web 탭→dock→`body` treeitem 선택→"Add to AI context"→"Added to context" 토스트 = 실 CDP `getOuterHTML`/`getBoxModel` end-to-end). 라이브편집·hook B 실 CDP 흐름은 §12대로 수동 GUI 스모크(dev 서버 서빙 자기앱 + 워크스페이스 필요).

**미완(다음)**: P5a/P5b Sources(transpiled 디버깅 + 소스맵 원본복원, 최대 규모·별도 세션). 잔여: 백그라운드 탭 고볼륨 도메인 pause(§4 M2), hook B Layer 2(Vite dev-id/외부 소스맵). 설정 마이그레이션 단위테스트는 `shared/settings.test.ts`로 완료.

## 20. P5a/P5b + parity 잔여 일괄 구현 (2026-06-12)

§19 이후 남아 있던 계획 항목을 일괄 구현. `tsc -b`·`vitest`(196 tests)·`vite build`·`eslint` 클린.

- **P5a Sources**: scriptParsed 트리 · 소스 뷰어(라인 거터 + 경량 구문 강조 `syntax.ts`) · url:line BP(리로드 생존, `_applySources` sticky 재적용) · pause/resume/step · 콜스택 · 스코프 · pause-on-exceptions.
- **P5b 소스맵 원본 복원**(§13-D3): 의존성 없는 v3 파서(`source-map.ts`, base64-VLQ) · 인라인 `data:` + 외부 `.map`은 CSP 우회를 위해 `Network.loadNetworkResource`→`IO.read`로 CDP 경유 페치 · Original/Compiled 토글 · BP 원본→생성 매핑 · paused/콜스택 생성→원본 역매핑 · 전 경로 best-effort(실패 시 생성 뷰 폴백). 미지원: indexed(sections) 맵.
- **DOMDebugger**: XHR/fetch BP(부분문자열, 빈 문자열=전체) + 이벤트 리스너 BP(큐레이트 16종) — sticky 재적용, paused 배너에 reason+aux 표기.
- **Watch 표현식**: paused 시 선택 프레임 `evaluateOnCallFrame`, 평시 `Runtime.evaluate`, objectGroup 라운드별 release.
- **Elements**: Event Listeners 패널(`DOMDebugger.getEventListeners`, objectGroup 즉시 release) · Accessibility 패널(`getPartialAXTree` + `CSS.getBackgroundColors` 대비) · Fonts 패널(`getPlatformFontsForNode`) · DOM 편집(Edit as HTML/삭제/숨김/복제, F2·H·Delete) · grid/flex 오버레이(선택 노드, sticky-overlay 해제 §E 준수).
- **Network**: WS 프레임 + SSE 메시지(연결당 500 캡, 바이너리는 크기만) · Initiator/Cookies 탭 · HAR 1.2 내보내기(body 미포함) · copy-as-fetch.
- **Application**: 쿼터(`Storage.getUsageAndQuota`) · Manifest · Frames 트리 · Service Worker 상태(읽기 전용 — 구동/변경 메서드 10종 BLOCKED).
- **Performance 패널**: 라이브 메트릭 + CPU 프로파일(top-down/bottom-up). **Security 패널**: visibleSecurityStateChanged(인증서 우회 메서드 BLOCKED).
- **Coverage**(Rendering 섹션): JS precise coverage + CSS rule usage, 미사용 바이트 정렬.
- 허용 도메인 추가: IndexedDB·CacheStorage·Security·ServiceWorker·DOMDebugger·Accessibility·IO (각 위험 메서드는 BLOCKED_METHODS로 차감 — §4 원칙 유지).

**잔여(후속)**: 백그라운드 탭 고볼륨 도메인 pause(§4 M2) · hook B Layer 2(Vite dev-id/CSS 소스맵) · 워커/OOPIF 멀티 타깃(`Target.setAutoAttach` flatten) · §14 heavy 항목(플레임 차트, 메모리 스냅샷, Layers, Lighthouse, Recorder) · 기기 에뮬레이션(보안 차단 유지 중 — 해제 여부는 별도 결정).
