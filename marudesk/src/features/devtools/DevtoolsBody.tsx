import { useDevtoolsStore } from './store';
import { ElementsPanel } from './panels/ElementsPanel';
import { ConsolePanel } from './panels/ConsolePanel';
import { NetworkPanel } from './panels/NetworkPanel';
import { ApplicationPanel } from './panels/ApplicationPanel';
import { RenderingPanel } from './panels/RenderingPanel';

/**
 * The session-aware panel body, shared by the in-page dock and the pop-out
 * window: a "Connecting…" / detached banner gate in front of the active panel.
 * Fills its flex parent (`flex-1 min-h-0`).
 */
export function DevtoolsBody() {
  const session = useDevtoolsStore((s) => s.session);
  const panel = useDevtoolsStore((s) => s.panel);
  return (
    <div className="flex-1 min-h-0 overflow-hidden">
      {session === 'detached' ? (
        <DetachedBanner />
      ) : session === 'attaching' ? (
        <div className="h-full flex items-center justify-center text-body-sm text-fg-tertiary">
          Connecting…
        </div>
      ) : panel === 'elements' ? (
        <ElementsPanel />
      ) : panel === 'console' ? (
        <ConsolePanel />
      ) : panel === 'network' ? (
        <NetworkPanel />
      ) : panel === 'application' ? (
        <ApplicationPanel />
      ) : (
        <RenderingPanel />
      )}
    </div>
  );
}

function DetachedBanner() {
  const reason = useDevtoolsStore((s) => s.detachReason);
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-body-sm text-fg-secondary">DevTools disconnected</p>
      {reason ? (
        <p className="text-caption text-fg-tertiary max-w-xs break-words">{reason}</p>
      ) : null}
      <button
        type="button"
        onClick={() => useDevtoolsStore.getState().reconnect()}
        className="h-7 px-3 rounded-md bg-accent-subtle/50 text-accent text-body-sm hover:bg-accent-subtle/70 transition-colors duration-fast"
      >
        Reconnect
      </button>
    </div>
  );
}
