import type { DevtoolsPanel } from './store';

/**
 * The panel registry (id → label), the source of truth for tool tab labels in
 * the main bar and the bottom drawer (DevtoolsContent). Data-only (no JSX) so it
 * doesn't trip the react-refresh export rule.
 *
 * Adding a panel = add it to the {@link DevtoolsPanel} union, here, the default
 * `DEFAULT_TOOLS` arrangement + `_enablePanel` in store.ts, and the `PanelById`
 * switch in DevtoolsBody.
 */
export const PANELS: { id: DevtoolsPanel; label: string }[] = [
  { id: 'elements', label: 'Elements' },
  { id: 'console', label: 'Console' },
  { id: 'sources', label: 'Sources' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'network', label: 'Network' },
  { id: 'application', label: 'Application' },
  { id: 'rendering', label: 'Rendering' },
  { id: 'performance', label: 'Performance' },
  { id: 'security', label: 'Security' },
];
