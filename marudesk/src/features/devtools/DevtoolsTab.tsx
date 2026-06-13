import { useEffect } from 'react';
import { useDevtoolsStore } from './store';
import { MainTabBar, DevtoolsContent } from './DevtoolsContent';

/**
 * DevTools rendered as a canvas card / classic tab (the `'devtools'` tab kind),
 * instead of the pop-out window (`devtools:popout-open`). On mount it binds the
 * shared CDP session to its target web tab via `_openFor`; the app-wide bridge
 * in the Shell (`useDevtoolsEvents`) does the event ingest, so — unlike the
 * pop-out window, which runs in its OWN renderer and wires its own bridge — this
 * adds NO listener of its own (that would double-ingest). The CDP relay is a
 * single session, so one DevTools surface is live at a time and follows the
 * active web tab thereafter (the existing dock/popout model, just in a card).
 */
export function DevtoolsTab({ targetTabId }: { targetTabId?: string }) {
  useEffect(() => {
    if (targetTabId) void useDevtoolsStore.getState()._openFor(targetTabId, 'right');
  }, [targetTabId]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-surface-1 text-fg-primary">
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-subtle bg-surface-2/40 pl-2 pr-1">
        <MainTabBar />
      </div>
      <DevtoolsContent />
    </div>
  );
}
