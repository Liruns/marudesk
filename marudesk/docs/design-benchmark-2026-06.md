# marudesk Design Benchmark — 2026-06

> 목적: Agentic IDE(Claude Desktop, Codex, Opencode, Antigravity 등)와 모던 브라우저(Arc, Zen, Opera, Vivaldi, Chrome), 그리고 디자인 레퍼런스(Linear, Raycast, Radix, Geist, shadcn)에서 흡수할 **디자인 / UX / 레이아웃 / 요소 배치** 후보 정리. 이제 기능보다 **사용자 경험 + 세련된 디자인**에 주력하기 위한 기준 문서.
>
> 방법: 4갈래 병렬 리서치(웹 검색 + OSS GitHub 소스) → 현재 marudesk 코드(`tokens.css`, `TitleBar`, `TabStrip`, `ActivityBar`, `StatusBar`, `AgentChat`)와 1:1 대조.
>
> 범례: ✅ 이미 있음 · 🟡 부분만 · ⬜ 없음(흡수 대상)

---

## 0. 결론 (방향성)

marudesk는 토큰 기반(Inter / JetBrains Mono / Linear violet 단일 액센트 / hairline border 3단계 / 모션 토큰 120·200ms / tabular-nums)이 이미 탄탄하다. 따라서 "디자인 시스템을 새로 깐다"가 아니라:

1. **빠진 마감 디테일 채우기** (스크롤바, focus 링, 아이콘 stroke, 소형 텍스트 트래킹 등 — 전역 CSS로 즉효)
2. **Agent / 탭 UX를 경쟁 제품 수준으로 끌어올리기** (통합 diff 리뷰, 권한 단계, plan 카드, 세션 receipt)

이 두 가지가 정확한 방향. positioning wedge("실행 중인 앱을 보는 AI = 런타임 DOM/네트워크/콘솔 via CDP")를 증폭하는 항목(세션 Receipt+스크린샷, Glance, Plan 카드)을 우선 배치.

---

## 1. ⭐ 교차 검증된 최강 신호 Top 10

여러 제품이 독립적으로 같은 결론에 수렴 → 가장 확신이 높은 흡수 후보.

| # | 패턴 | 출처(수렴) | 현재 | 적용 포인트 |
|---|------|-----------|------|------------|
| 1 | **통합 멀티파일 Diff 리뷰**: "N files changed · +47/−12 ›" 배너 → 변경 파일 전체 한 탭 stitch, hunk 단위 accept/reject | Zed·Codex·VS Code·Windsurf·Claude Desktop | 🟡 (개별 `DiffBlock`만) | Monaco diff editor 모아 한 탭; AgentChat→EditorView |
| 2 | **Transcript 상세도 다이얼** (Normal/Verbose/Summary, `Ctrl+O`) | Claude Desktop | ⬜ | `AgentChat` 툴바 토글, tool 카드 기본 collapse |
| 3 | **권한 3단계** (once / always=패턴저장 / reject) + **세션별 autonomy preset** | Opencode·Zed·VS Code·Claude | 🟡 (전역 skip 토글뿐) | approval IPC 확장 — "이 도구 항상 허용" |
| 4 | **"Blocked" 상태를 사이드바 영구 배지로** (모달로 안 막음) | Antigravity | ⬜ | gated-approval을 세션 항목 배지로 |
| 5 | **범용 Command Palette** (`Ctrl+K`: 탭검색/split/모델/설정/AI) | Arc·Codex·Linear·Raycast | 🟡 (파일 `Ctrl+P` + 모델 팔레트 분리) | QuickOpen 확장 or 통합 팔레트 |
| 6 | **Pre-flight Plan 카드 / Plan 모드** | Antigravity·Claude | ⬜ | composer에 Plan 모드, 계획을 카드로 |
| 7 | **Companion 사이드바** (live 플랜·소스·생성물, transcript와 분리) | Codex·Antigravity | 🟡 (`ContextDrawer` 토대) | 드로어에 plan/artifact 패널 |
| 8 | **세션 완료 Receipt**: 요약 + 실행 앱 스크린샷 + 콘솔에러 수 | Antigravity | ⬜ | **CDP 강점과 정확히 일치** |
| 9 | **Context window 잔량 인디케이터** + usage ring | Windsurf·Claude | ⬜ | `StatusBar` / composer 하단 얇은 바 |
| 10 | **Glance/Peek 오버레이** (링크를 새 탭 말고 플로팅 모달, 스크롤 유지) | Zen(Alt+Click)·Arc(Shift+Click) | ⬜ | AI 답변 링크를 Glance로 |

---

## 2. 카테고리별 흡수 후보

### A. 비주얼 폴리시 — 토큰/CSS 즉효 (가장 싸고 효과 큼)

출처: Linear · Raycast · Radix Colors · Geist · shadcn/ui.

| 항목 | 현재 | 적용 |
|------|------|------|
| **커스텀 얇은 스크롤바** (6px, thumb `rgba(255,255,255,.12)`, hover .20, track transparent) | ⬜ (전역 미적용, `scrollbar-none`만) | `index.css` 전역 `::-webkit-scrollbar`. Electron 기본 스크롤바가 "옛날 앱" 인상의 가장 큰 원인 |
| **`:focus-visible` 링 통일** (`box-shadow: 0 0 0 2px var(--ring)`, offset 2px, `:focus` 제거) | 🟡 (일부만) | `--ring` 토큰 + 전역 규칙 |
| **소형 텍스트 letter-spacing** (≤13px에 +0.3px) | 🟡 (md-prose만) | caption 유틸 / StatusBar / 탭 라벨 |
| **Inter OpenType** `"calt","kern","liga","ss03"` | 🟡 (`tnum,cv11`만) | body `font-feature-settings` |
| **UI 라벨 weight 500** (사이드바/탭/버튼) | 🟡 | 어두운 배경에서 400은 묻힘 |
| **Lucide stroke-width 1.5** (≤16px 아이콘) | ⬜ (기본 2) | 전역 `svg.lucide{stroke-width:1.5}` |
| **Elevation = 명도 단계** (그림자 아닌 lightness) | ✅ 거의 됨 | surface 델타 미세조정만 |
| **명령 팔레트 blur** (560px, `backdrop-filter: blur(20px)`) | 🟡 | 팔레트 구현 시 |

> ✅ 유지: 단일 violet 액센트 규율, hairline border 3단계, JetBrains Mono, tabular-nums, 모션 토큰(120/200ms + `cubic-bezier(0.2,0,0,1)`).
>
> **참고 값(Radix/Raycast 기준):** thumb 6px가 sweet spot(4px는 트랙패드 외 드래그 난해). focus 링 2–3px. small text(≤13px) +0.1~0.4px tracking. UI 라벨 weight 500.

### B. Agent Chat UX (가장 경쟁이 치열)

| 항목 | 출처 | 현재 | 적용 |
|------|------|------|------|
| 통합 멀티파일 diff 리뷰 (Top1) | Zed/Codex/VS Code | 🟡 | 최우선 |
| Transcript 상세도 다이얼 (Top2) | Claude Desktop | ⬜ | |
| 권한 3단계 + autonomy preset (Top3) | Opencode/Zed | 🟡 | |
| Plan 카드/모드 (Top6) | Antigravity/Claude | ⬜ | |
| 세션 Receipt + 스크린샷 (Top8) | Antigravity | ⬜ | CDP 차별화 |
| **메시지별 Checkpoint/Restore** (실행 전 파일 스냅샷) | Zed·VS Code | ⬜ | git stash/메모리 |
| **채팅 코드블록을 에디터 테마와 동기화** | Windsurf | ⬜ | 현재 highlight.js `github-dark` 고정 → Monaco 테마 |
| **composer `!` 셸 출력 단축** | Opencode | 🟡 (`@`멘션 ✅) | `!` prefix → 터미널 |
| **Tool 카드 인자/반환값 expand** | Windsurf | 🟡 | `⟩` 토글 |
| **여러 세션 = 세션 탭 / Kanban 오버뷰** | Windsurf | ⬜ | `agent:session-id` 탭 kind |
| **OS 알림 + 짧은 사운드 큐** (승인 대기) | Codex·Opencode | 🟡 (모바일만) | `main.ts` native notification |
| 음성 받아쓰기 (`Ctrl+M`) | Codex | ⬜ | 선택적 |

> ✅ 유지: reasoning/Thinking 블록, CDP-evidence 칩, full 탭+drawer 양면 투영, @-mention, 모델 팔레트, AI-timeline 4색.

### C. 탭 · 브라우저 · 레이아웃 (브라우저 내장 강점 활용)

| 항목 | 출처 | 현재 | 적용 |
|------|------|------|------|
| Glance/Peek 오버레이 (Top10) | Zen·Arc | ⬜ | agentic 리서치 핵심 |
| **Workspace/Space 아이덴티티** (그라데이션 뱃지 + 비활성 `grayscale→color` 0.2s) | Arc·Zen | ⬜ | 프로젝트별 색 정체성 |
| **Compact/Focus 모드** (단축키로 strip+activity+status 동시 숨김, hover-flash 800ms) | Zen | ⬜ | 임베디드 브라우저 세로 공간 |
| **사이드바 Web Panel** (참조 URL 상주: docs/PR/Jira) | Vivaldi | ⬜ | VS Code 대비 방어 가능한 갭 |
| **자동 Tab Islands / 컬러 그룹** (같은 host 자동 묶음, hover 핸들→색·이름) | Opera·Chrome·Vivaldi | 🟡 (split brackets ✅, host 그룹/색 ⬜) | 리서치 시 탭 폭주 완화 |
| **탭 검색** (전체 탭 fuzzy) | Chrome | ⬜ (`Ctrl+P`는 파일) | 팔레트 탭 채널 |
| **Pinned 탭 레일 + idle 자동 아카이브** | Arc | ⬜ | 웹 탭 TTL |
| **drag-to-split drop 어포던스** ("Drop to tile here") | Vivaldi | 🟡 (`setDraggingTab` seed grid ✅) | 드롭 타깃 시각화 |
| **favicon 색 adaptive chrome** (dominant color 미세 tint) | Opera Air | ⬜ | favicon 이미 추출 중 |
| **사이드바 좌/우 토글** | Zen | ⬜ | activity bar 우측 옵션 |
| **사이드바 자동 collapse + hover-to-peek** (48↔240px) | Arc | 🟡 (토글만) | Explorer hover peek |

### D. 모션 / 마이크로 인터랙션

출처: Linear · Raycast · Material 3 Expressive · Framer Motion.

| 항목 | 현재 | 적용 |
|------|------|------|
| **닫기 애니메이션을 열기보다 20–40% 짧게** | 🟡 | 모달/툴팁 close 150 vs open 200 |
| **물리적 spring**은 drag-reorder/resize/snap만, opacity·색은 tween | 🟡 | 탭 reorder·pane resize |
| **`prefers-reduced-motion` 가드** | ⬜ | 전역 1줄 |
| **Skeleton shimmer** | 🟡 (empty state ✅) | 로딩 스켈레톤 |
| 탭/그룹 컬러 fill + pill 컬러 피커 (dot 아닌 헤더 전체) | ⬜ | Tab Islands와 함께 |

> **참고 값:** UI 진입 `cubic-bezier(0,0,0.2,1)` ease-out, 패널 슬라이드 `cubic-bezier(0.32,0.72,0,1)`. spring: 버튼 `{stiffness:400,damping:28}`, 패널 `{300,30}`, 모달 `{200,24,mass:0.8}`. close는 항상 open보다 짧게.

### E. 디자인 시스템 인프라 (중기 투자)

| 항목 | 출처 | 현재 | 적용 |
|------|------|------|------|
| **3단계 Density** (Compact/Default/Comfortable = `--density-ratio` 0.75/1.0/1.25, 모든 px `calc()`) | Zed | ⬜ | 탭/행/바 높이 일괄 |
| **테마 커스터마이즈** (base + accent/bg/fg + UI/code 폰트, 공유) | Codex | 🟡 (light/dark만) | 설정 Theme 섹션 |
| **빌트인 테마 프리셋** (tokyonight/catppuccin 등 + 60+ 시맨틱 토큰: diff/syntax 포함) | Opencode·Zed | 🟡 (토큰 견고하나 syntax 부족) | 프리셋 + theme.json |
| **Theme Builder + Inspector** (hover 요소→제어 토큰 표시) | Zed | ⬜ | dev 모드 |
| **레이아웃 프리셋** (onboarding 선택) | Vivaldi | ⬜ | 설정 dropdown |
| **`.marudesk/workflows/*.md`** (`/이름` 호출, repo와 버전관리) | Windsurf | ⬜ | 프롬프트를 코드 아티팩트로 |
| 단일 surface chrome | Vivaldi 8 | ✅ 거의 됨 | 유지 |

---

## 3. 제품별 핵심 디테일 (참고)

### Claude Code Desktop
- Transcript 3단(Normal/Verbose/Summary, `Ctrl+O`) — agentic 노이즈 해결의 정석.
- Side chat 분기(`Cmd+;`): 현재 컨텍스트 상속, 메인 스레드 미오염.
- `+12 -1` diff stat 배지 → diff 뷰어(파일목록 좌 / diff 우), 라인 클릭 코멘트 → `Cmd+Enter` 일괄 제출.
- Permission 모드 셀렉터(Ask/Auto accept/Plan/Auto/Bypass)를 composer 옆 named dropdown.
- Usage ring(컨텍스트 소비 %), PR merge 시 세션 자동 archive, 세션=git worktree.
- 상단 3탭(Chat / Cowork / Code)로 밀도 다른 작업 분리.

### OpenAI Codex App
- Task 사이드바 = agent scratchpad(plan/sources/artifacts/summary 라이브).
- Diff pane: 라인 코멘트 + chunk 단위 stage/revert(양방향).
- `Cmd+K` 팔레트. 풀 테마 커스터마이즈(base + accent/bg/fg + UI/code 폰트, 공유). 팝아웃 always-on-top. 음성(`Ctrl+M`). 백그라운드 OS 알림.

### Opencode (OSS: opencode-ai/opencode)
- Berkeley Mono 단일 폰트 정체성 — agentic 표면은 mono-first, chrome은 proportional 대비.
- 62 시맨틱 컬러 토큰(diff/markdown/syntax 포함) + 20+ 빌트인 테마.
- PermissionPrompt 3-scope: once / always(패턴 저장) / reject.
- diff 파일 트리에 git status 배지 A/M/D.
- composer `@` 파일 fuzzy + `!` 셸 결과 주입. 세션 Markdown export. 데스크톱 알림 + 사운드팩.

### Google Antigravity
- Manager View = 에디터와 동급 표면(좌: workspaces, 중: Inbox[Idle/Running/Blocked], 우: 작업영역). 최대 5 에이전트 동시.
- Artifacts = 구조화 산출물(Task List + Implementation Plan + Walkthrough[스크린샷·테스트결과]), 채팅 메시지가 아니라 열고/리뷰/주석/archive 가능한 객체.
- Google Docs식 인라인 코멘트(계획/diff 하이라이트 → 비동기 피드백).
- `Blocked` = 영구 상태(모달 아님). Implementation Plan = pre-flight 리뷰. Browser Sub-Agent가 스크린샷·녹화를 Artifact로. Walkthrough = "실행 앱 스크린샷" 영수증.

### Zed (OSS: zed-industries/zed)
- GPUI 120fps. 3단 Density(`ui_density.rs`, ratio 0.75/1.0/1.25; `DynamicSpacing` Base04~48 각 3값).
- Theme JSON ~100 시맨틱 토큰 flat namespace(`tab.active_background`, `editor.active_line.background`, `version_control.added`, `title_bar.inactive_background`…). `one.json` 참조.
- Tab: position×selected 따라 border 규칙(활성 탭 bottom border 제거 → "떠 보임", 그림자 0). Button 7종(대부분 Subtle).
- Agent panel: "N files changed" 접이식 → multi-buffer 리뷰 탭(파일별 hunk accept/reject) + 메시지별 Checkpoint Restore. 권한 once/always/pattern. Live Theme Builder + Inspector.

### Cursor / Windsurf / VS Code+Copilot
- Cursor: 자율성 슬라이더(Tab→Cmd+K→Composer→background agent) 단일 멘탈모델. 인라인 red/green hunk + 키보드 accept/reject. diff 리뷰는 신뢰 기능(자동 적용 = 커뮤니티 반발).
- Windsurf: Cascade 멀티세션 탭, 디스크 쓰기 전 staging, 모든 tool 호출=카드(인자/반환), context window + cache 타이머 표시, `.windsurf/workflows/*.md`, Kanban Agent Command Center, 채팅 코드블록 = 에디터 테마.
- VS Code: 별도 Agents Window(agent-first 레이아웃), multi-file 요약 diff 탭, source-control stage=암묵 accept, checkpoints, 권한 named preset(Default/Bypass/Autopilot, per-session).

### Arc / Zen / Opera / Vivaldi / Chrome
- Arc: 사이드바 2-tier(pinned vs 12h auto-archive), hover-to-peek(48↔240px), Spaces(그라데이션 28px 뱃지, `Cmd+1/2`, spring), Command Bar(`Cmd+T`), Peek/Little Arc, Boosts(도메인별 CSS/JS).
- Zen(OSS: zen-browser/desktop): Compact Mode(`Cmd+Alt+C`, flash 800ms), Workspaces(container 격리, grayscale→color 0.2s), Glance(Alt+Click), Split View(최대 4, 2×2), Mods(CSS-only 토글), 사이드바 좌/우(`zen.tabs.vertical.right-side`).
- Opera: Tab Islands(자동 host 그룹, R3에서 9색+이름), Opera Air(favicon/site 색 adaptive frosted glass, ambient depletion indicator).
- Vivaldi 8.0: Unified 단일 surface(컴포지팅 레이어↓ GPU 5%↓), 6 레이아웃 프리셋, drag-to-tile, **Web Panels**(사이드바 상주 미니 브라우저), tree-style tabs, 컬러 tab stacks.
- Chrome: 네이티브 vertical tabs(146), Material 3 Expressive(그룹 헤더 전체 색 fill, spring bounce), 탭 검색, side panel.

### 디자인 레퍼런스 (Linear/Raycast/Radix/Geist/shadcn)
- 컬러: Radix 12-step 시맨틱(1 app bg … 12 primary text); dark는 elevation=lightness 단계(+5~8 L), 그림자 X. mauve/slate-dark 추천. OKLCH 사용(perceptual). 액센트 1개, 큰 면적 배경 금지.
- 타이포: Inter(UI) + JetBrains Mono(code). 소형 +tracking, 대형 0/음수. UI 라벨 weight 500. line-height 1.4–1.6. tabular-nums.
- 스페이싱: 4/8 그리드. 리스트행 28–32px, 인풋/버튼 32–36px, context menu item 28px.
- 깊이: 1px hairline `rgba(255,255,255,.06~.10)`, floating만 그림자 + `backdrop-filter: blur`. glass on glass 금지.
- 모션: hover 100–120, 메뉴 120–150, 패널 200–250, 모달 200(close 150). close < open. `focus-visible`만.
- 아이콘: Lucide, ≤16px는 stroke 1.5, 한 행에 사이즈/stroke 혼용 금지.
- 스크롤바: 6px webkit + `scrollbar-width:thin`.

---

## 4. 추천 실행 순서 (impact ÷ effort)

1. **Sprint 1 — 비주얼 마감 (전역 CSS, 반나절):** 커스텀 스크롤바 · `focus-visible` 링 · Lucide stroke 1.5 · 소형 텍스트 tracking · Inter `calt/liga/ss03` · UI 라벨 weight 500. → 코드 거의 안 건드리고 "세련됨" 즉시 상승.
2. **Sprint 2 — Agent 신뢰 UX:** 통합 멀티파일 diff 리뷰(Top1) + Transcript 다이얼(Top2) + "Blocked" 사이드바 배지(Top4).
3. **Sprint 3 — CDP 차별화 증폭:** 세션 Receipt+스크린샷(Top8) + Plan 카드(Top6) + Glance 오버레이(Top10).
4. **Sprint 4 — 인프라:** Density 시스템 + 테마 프리셋/커스터마이즈.

---

## 5. 소스

**Agentic 앱**
- Claude Desktop: https://claude.com/blog/claude-code-desktop-redesign · https://code.claude.com/docs/en/desktop
- Codex: https://developers.openai.com/codex/app/features · https://developers.openai.com/codex/app/settings
- Opencode: https://opencode.ai/docs/tui/ · https://opencode.ai/docs/themes/ · https://deepwiki.com/sst/opencode
- Antigravity: https://developers.googleblog.com/build-with-google-antigravity-our-new-agentic-development-platform/ · https://betterstack.com/community/guides/ai/antigravity-ai-ide/ · https://www.index.dev/blog/google-antigravity-agentic-ide

**AI 코드 에디터**
- Cursor: https://cursor.com · https://cursor.com/docs/inline-edit/overview
- Windsurf: https://windsurf.com/changelog · https://www.digitalapplied.com/blog/windsurf-2-deep-dive-cascade-agents-flows-2026
- Zed: https://zed.dev/docs/ai/agent-panel · https://github.com/zed-industries/zed (`assets/themes/one/one.json`, `crates/ui/src/components/tab.rs`, `crates/ui/src/styles/spacing.rs`, `crates/theme/src/ui_density.rs`)
- VS Code + Copilot: https://code.visualstudio.com/docs/copilot/chat/copilot-chat · https://code.visualstudio.com/docs/copilot/agents/overview

**브라우저**
- Arc: https://blakecrosley.com/guides/design/arc · https://medium.com/design-bootcamp/arc-browser-rethinking-the-web-through-a-designers-lens-f3922ef2133e
- Zen: https://github.com/zen-browser/desktop · https://deepwiki.com/zen-browser/desktop/3.6-advanced-ui-features
- Opera: https://blogs.opera.com/desktop/2025/11/opera-developer-new-ways-to-customize-your-tab-islands/ · https://designcompass.org/en/2025/02/07/opera-air/
- Vivaldi: https://vivaldi.com/blog/vivaldi-on-desktop-8-0/ · https://help.vivaldi.com/desktop/panels/web-panels/
- Chrome: https://blog.google/products-and-platforms/products/chrome/new-chrome-productivity-features/

**디자인 레퍼런스**
- Radix Colors: https://www.radix-ui.com/colors · Linear: https://linear.app/now/how-we-redesigned-the-linear-ui
- Raycast DESIGN.md (awesome-design-md) · Geist: https://vercel.com/geist/typography · shadcn: https://ui.shadcn.com/docs/theming · Motion: https://motion.dev/docs/react-transitions · Lucide: https://lucide.dev/guide/react/basics/stroke-width
