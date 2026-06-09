import { type ComponentType, type ReactNode } from 'react';
import { Blocks, Code2, Globe, House, Sparkles, SlidersHorizontal, SquareTerminal } from 'lucide-react';
import { AgentTab } from '../agent/AgentTab';
import { BrowserCanvas } from '../browser/BrowserCanvas';
import { EditorView } from '../editor/EditorView';
import { HomeView } from '../home/HomeView';
import { PluginPanel } from '../plugins/PluginPanel';
import { SettingsView } from '../settings/SettingsView';
import { TerminalSurface } from './TerminalSurface';
import type { TabKind, TabState } from '../../../shared/browser';

export type TabKindDef = {
  /** Default display title for a tab of this kind (web derives it from the page). */
  title: string;
  /** The strip / pane glyph for this kind. */
  icon: ComponentType<{ size?: number }>;
  /**
   * The React surface for a tab of this kind. `tabId` is supplied in grid mode
   * so a pane resolves its own pinned tab; the single view omits it and the
   * surface follows the active tab. NOTE: `web` returns the BrowserCanvas chrome
   * for the single view — the grid paints web panes onto a measured placeholder
   * instead and never calls this.
   */
  render: (tabId?: string, tab?: TabState) => ReactNode;
};

/**
 * Single source of truth for "what a tab kind looks like": its title, strip
 * icon, and the view it renders. Both the single-view dispatch (`Stage`) and the
 * grid pane dispatch (`GridStage`) route through `render`, and the tab strip
 * reads `icon` — so a new tab kind is wired up in exactly one place instead of
 * the three switch statements that used to drift.
 */
export const tabKinds: Record<TabKind, TabKindDef> = {
  web: { title: 'New tab', icon: Globe, render: (tabId) => <BrowserCanvas tabId={tabId} /> },
  home: { title: 'New Tab', icon: House, render: (tabId) => <HomeView tabId={tabId} /> },
  terminal: {
    title: 'Terminal',
    icon: SquareTerminal,
    render: (tabId) => <TerminalSurface tabId={tabId} />,
  },
  editor: {
    title: 'Editor',
    icon: Code2,
    render: (tabId) => <EditorView tabId={tabId} />,
  },
  settings: {
    title: 'Settings',
    icon: SlidersHorizontal,
    render: () => <SettingsView />,
  },
  agent: {
    title: 'AI Chat',
    icon: Sparkles,
    render: (_tabId, tab) => <AgentTab workspaceId={tab?.workspaceId} />,
  },
  plugin: {
    title: 'Plugin',
    icon: Blocks,
    render: (tabId) => <PluginPanel tabId={tabId} />,
  },
};
