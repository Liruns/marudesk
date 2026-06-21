import type { TranslationKey } from '../../i18n/messages';
import type { SettingsCategory } from './store';

/**
 * A single, individually-searchable setting. The Settings search reads this flat
 * catalog so a query can match a control *inside* a category (e.g. "shell",
 * "fallback", "reasoning") and jump straight to it — the left-nav category list
 * only knows category-level labels. `keywords` is a lowercase, space-separated
 * bag of synonyms in both locales so search works regardless of UI language.
 *
 * This is hand-authored metadata that mirrors the controls each category renders;
 * when a category gains or renames a control, add/adjust its entry here.
 */
export type SettingsEntry = {
  readonly categoryId: SettingsCategory;
  readonly labelKey: TranslationKey;
  readonly keywords: string;
};

export const SETTINGS_CATALOG: readonly SettingsEntry[] = [
  // Appearance
  {
    categoryId: 'appearance',
    labelKey: 'settings.appearance.theme.label',
    keywords: 'theme dark light system mode 테마 어둡게 밝게 시스템 모드',
  },
  {
    categoryId: 'appearance',
    labelKey: 'settings.appearance.uiZoom.label',
    keywords: 'zoom scale interface size 확대 축소 배율 크기',
  },
  {
    categoryId: 'appearance',
    labelKey: 'settings.appearance.chatZoom.label',
    keywords: 'chat zoom transcript ai font size 채팅 대화 확대 배율 글자',
  },
  {
    categoryId: 'appearance',
    labelKey: 'settings.appearance.uiFont.label',
    keywords: 'ui font family typeface 글꼴 폰트 서체',
  },
  {
    categoryId: 'appearance',
    labelKey: 'appearance.accent.label',
    keywords: 'accent color swatch highlight 강조색 색상 컬러',
  },
  {
    categoryId: 'appearance',
    labelKey: 'appearance.language.label',
    keywords: 'language locale english korean 언어 한국어 영어 로케일',
  },

  // Editor
  {
    categoryId: 'editor',
    labelKey: 'settings.font.family.label',
    keywords: 'editor monaco code font family 편집기 코드 글꼴',
  },
  {
    categoryId: 'editor',
    labelKey: 'settings.font.size.label',
    keywords: 'editor code font size 편집기 코드 글꼴 크기',
  },
  {
    categoryId: 'editor',
    labelKey: 'settings.editor.formatOnSave.label',
    keywords: 'format on save prettier formatter editor 저장 서식 포맷 정리 편집기',
  },
  {
    categoryId: 'editor',
    labelKey: 'settings.editor.inlineBlame.label',
    keywords: 'blame git inline annotation author commit gitlens 블레임 깃 커밋 작성자 줄',
  },

  // Terminal
  {
    categoryId: 'terminal',
    labelKey: 'settings.font.family.label',
    keywords: 'terminal font family 터미널 글꼴',
  },
  {
    categoryId: 'terminal',
    labelKey: 'settings.font.size.label',
    keywords: 'terminal font size 터미널 글꼴 크기',
  },
  {
    categoryId: 'terminal',
    labelKey: 'settings.terminal.shell.label',
    keywords: 'shell bash zsh powershell pty default 셸 기본 셸',
  },
  {
    categoryId: 'terminal',
    labelKey: 'settings.terminal.cliCommand.label',
    keywords: 'marudesk command cli path install terminal chat 명령 명령어 설치 터미널 채팅',
  },

  // Application (window close, search engine, DevTools dock)
  {
    categoryId: 'application',
    labelKey: 'settings.browser.searchEngine.label',
    keywords: 'search engine google bing duckduckgo address bar browser 검색 엔진 주소창 브라우저',
  },
  {
    categoryId: 'application',
    labelKey: 'settings.window.closeBehavior.label',
    keywords: 'close quit tray background exit hide window 닫기 종료 트레이 백그라운드 숨기기 창',
  },
  {
    categoryId: 'application',
    labelKey: 'settings.devtools.dock.label',
    keywords:
      'devtools dock right bottom chrome inspector console network 검사기 도킹 콘솔 개발자도구',
  },
  {
    categoryId: 'application',
    labelKey: 'settings.sshHostKeys.title',
    keywords: 'ssh host key fingerprint pinned tofu known hosts 호스트 키 지문 고정',
  },

  // AI Providers
  {
    categoryId: 'providers',
    labelKey: 'settings.category.providers.label',
    keywords:
      'api key provider openai anthropic claude gemini grok ollama oauth model token 제공자 키 모델 토큰',
  },

  // AI Agent
  {
    categoryId: 'agent',
    labelKey: 'settings.agent.approval.label',
    keywords: 'approval mode plan ask auto read only 승인 모드 계획 자동',
  },
  {
    categoryId: 'agent',
    labelKey: 'settings.agent.reasoning.label',
    keywords: 'reasoning effort thinking budget 추론 사고 노력',
  },
  {
    categoryId: 'agent',
    labelKey: 'settings.agent.instructions.label',
    keywords: 'custom instructions prompt system tone 사용자 지시 프롬프트',
  },
  {
    categoryId: 'agent',
    labelKey: 'settings.agent.neverEdit.label',
    keywords: 'never edit deny glob protected paths secrets 보호 경로 수정 금지',
  },
  {
    categoryId: 'agent',
    labelKey: 'settings.agent.verifyCommand.label',
    keywords: 'verify command typecheck post edit hook 검증 명령',
  },
  {
    categoryId: 'agent',
    labelKey: 'settings.agent.contextCommand.label',
    keywords: 'context command per turn hook userpromptsubmit git status 컨텍스트 명령',
  },
  {
    categoryId: 'agent',
    labelKey: 'settings.agent.fallback.label',
    keywords: 'fallback model chain rate limit failover 대체 모델 체인',
  },
  {
    categoryId: 'agent',
    labelKey: 'settings.agent.autoCompact.label',
    keywords: 'auto compact compaction summarize context window threshold 자동 압축 요약 컨텍스트',
  },
  {
    categoryId: 'agent',
    labelKey: 'settings.agent.pcControl.label',
    keywords: 'pc control open files folders urls reveal 제어 파일 폴더',
  },

  // MCP Servers
  {
    categoryId: 'mcp',
    labelKey: 'settings.category.mcp.label',
    keywords: 'mcp server stdio http remote url tools context 서버 도구 컨텍스트',
  },
  {
    categoryId: 'mcp',
    labelKey: 'settings.mcp.debugPort.label',
    keywords: 'browser debug port cdp remote debugging chrome devtools security 디버그 포트 보안 원격 디버깅',
  },

  // Data & Storage
  {
    categoryId: 'data',
    labelKey: 'settings.data.persistSessions.label',
    keywords: 'save chat sessions transcripts history persist 세션 저장 기록',
  },
  {
    categoryId: 'data',
    labelKey: 'settings.data.persistTabs.label',
    keywords: 'restore tabs launch reopen 탭 복원 시작',
  },
  {
    categoryId: 'data',
    labelKey: 'settings.data.clearSessions.label',
    keywords: 'clear delete sessions wipe 세션 삭제 지우기',
  },
  {
    categoryId: 'data',
    labelKey: 'settings.data.sessionStorage.label',
    keywords: 'storage usage sqlite json disk size 저장소 사용량',
  },
  {
    categoryId: 'data',
    labelKey: 'settings.data.reset.label',
    keywords: 'reset defaults restore 초기화 기본값',
  },

  // About
  {
    categoryId: 'about',
    labelKey: 'settings.about.version',
    keywords: 'version build 버전',
  },
  {
    categoryId: 'about',
    labelKey: 'settings.about.updates.label',
    keywords: 'update check release github 업데이트 확인 릴리스',
  },
  {
    categoryId: 'about',
    labelKey: 'settings.about.github.label',
    keywords: 'github source repository issues 깃허브 저장소',
  },
];
