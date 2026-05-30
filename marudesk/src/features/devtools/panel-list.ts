import type { DevtoolsPanel } from './store';

/**
 * The panel registry, shared by the in-page dock (DevtoolsDock) and the pop-out
 * window (DevtoolsWindow) so the two stay in lockstep when a panel is added.
 * Data-only (no JSX) so it doesn't trip the react-refresh export rule.
 *
 * Adding a panel = add it to the {@link DevtoolsPanel} union, here, and
 * `_enablePanel`/`freshSlices` in store.ts + the body switch in DevtoolsBody.
 */
export const PANELS: { id: DevtoolsPanel; label: string }[] = [
  { id: 'elements', label: 'Elements' },
  { id: 'console', label: 'Console' },
  { id: 'network', label: 'Network' },
  { id: 'application', label: 'Application' },
  { id: 'rendering', label: 'Rendering' },
];
