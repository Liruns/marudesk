import { useI18n } from '../../../i18n/useI18n';
import { useEffect, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { useDevtoolsStore } from '../store';
import { cdpTry } from '../cdp';
import type { EventListenerInfo, RemoteObject } from '../types';
import {
  formatListenerLocation,
  groupListenersByType,
  handlerPreview,
} from './elements-utils';

/**
 * The Event Listeners pane for the selected node: `DOM.resolveNode` lifts the
 * nodeId to a Runtime objectId, `DOMDebugger.getEventListeners` lists the
 * listeners attached to it. Re-fetched on every selection change. The transient
 * RemoteObjects are scoped to an objectGroup and released right after the fetch
 * (the rendered previews are plain strings from the response), so the pane
 * never leaks page memory (§E).
 */

// All RemoteObjects from this pane live in one releasable group.
const OBJECT_GROUP = 'devtools-event-listeners';

function Flag({ label }: { label: string }) {
  return (
    <span className="px-1 rounded-sm bg-surface-3 text-fg-tertiary text-caption leading-4">
      {label}
    </span>
  );
}

function ListenerRow({ listener }: { listener: EventListenerInfo }) {
  const url = useDevtoolsStore((s) => s.scripts.get(listener.scriptId)?.url);
  const preview = handlerPreview(listener.handler?.description);
  return (
    <div className="pl-4 pr-2 py-0.5">
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="font-mono text-caption text-fg-secondary truncate" title={url}>
          {formatListenerLocation(listener, url)}
        </span>
        {listener.useCapture ? <Flag label="capture" /> : null}
        {listener.passive ? <Flag label="passive" /> : null}
        {listener.once ? <Flag label="once" /> : null}
      </div>
      {preview ? (
        <div className="font-mono text-caption text-fg-tertiary truncate" title={preview}>
          {preview}
        </div>
      ) : null}
    </div>
  );
}

export function EventListenersPane() {
  const { t } = useI18n();
  const tabId = useDevtoolsStore((s) => s.tabId);
  const selectedId = useDevtoolsStore((s) => s.selectedId);
  // null = loading (a finished fetch always lands an array). Reset on selection
  // change via the store-previous-prop pattern (render-time, no effect cascade).
  const [listeners, setListeners] = useState<EventListenerInfo[] | null>(null);
  // Bumped by the refresh button to re-run the fetch for the same node.
  const [refreshSeq, setRefreshSeq] = useState(0);
  const key = `${tabId ?? ''}:${selectedId ?? 'none'}`;
  const [prevKey, setPrevKey] = useState(key);
  if (prevKey !== key) {
    setPrevKey(key);
    setListeners(null);
  }

  useEffect(() => {
    let cancelled = false;
    if (!tabId || selectedId === null) return;
    void (async () => {
      const resolved = await cdpTry<{ object: RemoteObject }>(tabId, 'DOM.resolveNode', {
        nodeId: selectedId,
        objectGroup: OBJECT_GROUP,
      });
      const objectId = resolved?.object.objectId;
      const res = objectId
        ? await cdpTry<{ listeners: EventListenerInfo[] }>(
            tabId,
            'DOMDebugger.getEventListeners',
            { objectId },
          )
        : undefined;
      // Previews are already plain strings in the response — release the page
      // objects immediately rather than on unmount.
      if (objectId) void cdpTry(tabId, 'Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP });
      if (!cancelled) setListeners(res?.listeners ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [tabId, selectedId, refreshSeq]);

  if (selectedId === null) {
    return (
      <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
        Select an element to inspect its event listeners
      </div>
    );
  }
  if (listeners === null) {
    return (
      <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
        Loading listeners...
      </div>
    );
  }

  const groups = groupListenersByType(listeners);

  return (
    <div className="h-full overflow-auto">
      <div className="flex items-center justify-between pl-2 pr-1 h-7 border-b border-subtle/60">
        <span className="text-caption text-fg-tertiary tabular-nums">
          {listeners.length} listener{listeners.length === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          aria-label={t('devtools.eventListeners.refreshAll')}
          title={t('devtools.eventListeners.refresh')}
          onClick={() => {
            setListeners(null);
            setRefreshSeq((n) => n + 1);
          }}
          className="size-5 rounded flex items-center justify-center text-fg-tertiary hover:text-fg-primary hover:bg-surface-2"
        >
          <RotateCw size={12} />
        </button>
      </div>
      {groups.length === 0 ? (
        <div className="text-caption text-fg-tertiary px-2 py-2">
          No event listeners on this element
        </div>
      ) : (
        groups.map(([type, items]) => (
          <div key={type} className="py-1 border-b border-subtle/60">
            <div className="px-2 font-mono text-caption text-fg-primary">
              {type}{' '}
              <span className="text-fg-tertiary tabular-nums">({items.length})</span>
            </div>
            {items.map((l, i) => (
              <ListenerRow key={i} listener={l} />
            ))}
          </div>
        ))
      )}
    </div>
  );
}
