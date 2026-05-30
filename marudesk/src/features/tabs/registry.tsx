import { type ComponentType, type ReactNode } from 'react';
import { Code2, Globe, House, SlidersHorizontal, SquareTerminal } from 'lucide-react';
import { BrowserCanvas } from '../browser/BrowserCanvas';
import { EditorView } from '../editor/EditorView';
import { HomeView } from '../home/HomeView';
import { SettingsView } from '../settings/SettingsView';
import { TerminalSurface } from './TerminalSurface';
import type { TabKind } from '../../../shared/browser';

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
  render: (tabId?: string) => ReactNode;
};

/**
 * Single source of truth for "what a tab kind looks like": its title, strip
 * icon, and the view it renders. Both the single-view dispatch (`Stage`) and the
 * grid pane dispatch (`GridStage`) route through `render`, and the tab strip
 * reads `icon` — so a new tab kind is wired up in exactly one place instead of
 * the three switch statements that used to drift.
 */
export const tabKinds: Record<TabKind, TabKindDef> = {
  web: { title: 'New tab', icon: Globe, render: () => <BrowserCanvas /> },
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
};
