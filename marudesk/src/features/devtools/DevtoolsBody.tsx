import type { DevtoolsPanel } from './store';
import { ElementsPanel } from './panels/ElementsPanel';
import { ConsolePanel } from './panels/ConsolePanel';
import { NetworkPanel } from './panels/NetworkPanel';
import { ApplicationPanel } from './panels/ApplicationPanel';
import { RenderingPanel } from './panels/RenderingPanel';

/**
 * Render one DevTools panel by id. The single panel↔id mapping, used by both the
 * main panel area and the bottom drawer (a tool can live in either) — see
 * DevtoolsContent. The session gate ("Connecting…" / detached banner) lives in
 * DevtoolsContent, which wraps this.
 *
 * Adding a panel = extend this switch (+ the {@link DevtoolsPanel} union, the
 * tool registry + `_enablePanel` in store.ts, and `PANELS` in panel-list.ts).
 */
export function PanelById({ panel }: { panel: DevtoolsPanel }) {
  switch (panel) {
    case 'elements':
      return <ElementsPanel />;
    case 'console':
      return <ConsolePanel />;
    case 'network':
      return <NetworkPanel />;
    case 'application':
      return <ApplicationPanel />;
    case 'rendering':
      return <RenderingPanel />;
  }
}
