import type {
  AgentApprovalMode,
  ReasoningEffort,
  SearchEngine,
  ThemeMode,
} from '../../../shared/settings';

export const THEME_OPTIONS = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' },
] as const satisfies readonly { readonly value: ThemeMode; readonly label: string }[];

export const SEARCH_ENGINE_OPTIONS = [
  { value: 'google', label: 'Google' },
  { value: 'duckduckgo', label: 'DuckDuckGo' },
  { value: 'bing', label: 'Bing' },
] as const satisfies readonly { readonly value: SearchEngine; readonly label: string }[];

export const APPROVAL_MODE_OPTIONS = [
  { value: 'plan', label: 'Plan' },
  { value: 'read-only', label: 'Read-only' },
  { value: 'ask', label: 'Ask' },
  { value: 'auto', label: 'Auto' },
] as const satisfies readonly { readonly value: AgentApprovalMode; readonly label: string }[];

export const ON_OFF_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
] as const;

export const REASONING_EFFORT_OPTIONS = [
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
] as const satisfies readonly { readonly value: ReasoningEffort; readonly label: string }[];
