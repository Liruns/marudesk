import type { ComponentType } from 'react';
import {
  AppWindow,
  BarChart3,
  Blocks,
  Bot,
  Clock,
  Code2,
  Database,
  Globe,
  Info,
  KeyRound,
  Palette,
  Plug,
  Radio,
  SquareTerminal,
  Wrench,
} from 'lucide-react';
import type { TranslationKey } from '../../i18n/messages';
import type { SettingsCategory } from './store';

type SettingsCategoryDefinition = {
  readonly id: SettingsCategory;
  readonly labelKey: TranslationKey;
  readonly blurbKey: TranslationKey;
  readonly icon: ComponentType<{ readonly size?: number }>;
  readonly keywords: string;
};

export type SettingsCategoryItem = {
  readonly id: SettingsCategory;
  readonly label: string;
  readonly blurb: string;
  readonly icon: ComponentType<{ readonly size?: number }>;
  readonly keywords: string;
};

const CATEGORY_DEFINITIONS = [
  {
    id: 'appearance',
    labelKey: 'settings.category.appearance.label',
    blurbKey: 'settings.category.appearance.blurb',
    icon: Palette,
    keywords: 'theme dark light zoom font color appearance ui 모양새 테마 확대 글꼴',
  },
  {
    id: 'editor',
    labelKey: 'settings.category.editor.label',
    blurbKey: 'settings.category.editor.blurb',
    icon: Code2,
    keywords: 'monaco font size code word wrap tab 편집기 코드 글꼴 크기',
  },
  {
    id: 'terminal',
    labelKey: 'settings.category.terminal.label',
    blurbKey: 'settings.category.terminal.blurb',
    icon: SquareTerminal,
    keywords: 'shell bash zsh powershell font terminal pty 터미널 셸 글꼴',
  },
  {
    id: 'browser',
    labelKey: 'settings.category.browser.label',
    blurbKey: 'settings.category.browser.blurb',
    icon: Globe,
    keywords: 'search engine google duckduckgo bing browser web 브라우저 검색 엔진',
  },
  {
    id: 'providers',
    labelKey: 'settings.category.providers.label',
    blurbKey: 'settings.category.providers.blurb',
    icon: KeyRound,
    keywords: 'api key openai anthropic claude gemini grok ollama oauth model provider token 제공자 키 모델',
  },
  {
    id: 'usage',
    labelKey: 'settings.category.usage.label',
    blurbKey: 'settings.category.usage.blurb',
    icon: BarChart3,
    keywords: 'usage quota rate limit tokens requests api cost budget 사용량 할당량 요금 토큰 요청',
  },
  {
    id: 'agent',
    labelKey: 'settings.category.agent.label',
    blurbKey: 'settings.category.agent.blurb',
    icon: Bot,
    keywords: 'approval reasoning effort instructions deny glob fallback pc control agent 에이전트 승인 추론 지시',
  },
  {
    id: 'mcp',
    labelKey: 'settings.category.mcp.label',
    blurbKey: 'settings.category.mcp.blurb',
    icon: Plug,
    keywords: 'mcp server stdio http remote url tools context 서버 도구 컨텍스트',
  },
  {
    id: 'plugins',
    labelKey: 'settings.category.plugins.label',
    blurbKey: 'settings.category.plugins.blurb',
    icon: Blocks,
    keywords: 'plugin extension customize sandbox tool slash command worker 플러그인 확장 커스터마이징 샌드박스 도구',
  },
  {
    id: 'automations',
    labelKey: 'settings.category.automations.label',
    blurbKey: 'settings.category.automations.blurb',
    icon: Clock,
    keywords: 'automation schedule cron interval daily background prompt recurring 자동화 스케줄 예약 반복 프롬프트',
  },
  {
    id: 'devtools',
    labelKey: 'settings.category.devtools.label',
    blurbKey: 'settings.category.devtools.blurb',
    icon: Wrench,
    keywords: 'devtools dock inspect console network 개발자도구 검사 콘솔 네트워크',
  },
  {
    id: 'remote',
    labelKey: 'settings.category.remote.label',
    blurbKey: 'settings.category.remote.blurb',
    icon: Radio,
    keywords: 'remote phone pair qr relay server mobile bridge 원격 휴대폰 페어링 서버',
  },
  {
    id: 'window',
    labelKey: 'settings.category.window.label',
    blurbKey: 'settings.category.window.blurb',
    icon: AppWindow,
    keywords: 'window close quit tray background minimize exit 창 닫기 종료 트레이 백그라운드',
  },
  {
    id: 'data',
    labelKey: 'settings.category.data.label',
    blurbKey: 'settings.category.data.blurb',
    icon: Database,
    keywords: 'data storage save persist session tab history database sqlite clear export disk backup 데이터 저장소 세션 탭 기록',
  },
  {
    id: 'about',
    labelKey: 'settings.category.about.label',
    blurbKey: 'settings.category.about.blurb',
    icon: Info,
    keywords: 'about version reset runtime 정보 버전 런타임',
  },
] as const satisfies readonly SettingsCategoryDefinition[];

export function getSettingsCategories(
  t: (key: TranslationKey) => string,
): readonly SettingsCategoryItem[] {
  return CATEGORY_DEFINITIONS.map((category) => ({
    id: category.id,
    label: t(category.labelKey),
    blurb: t(category.blurbKey),
    icon: category.icon,
    keywords: category.keywords,
  }));
}
