import { useEffect, useRef } from 'react';
import type { EventChannel, EventPayload } from '../../shared/ipc';

/**
 * Subscribe to one main→renderer IPC event for the lifetime of the component.
 * Wraps the `window.marudesk.on(channel, …)` + cleanup pattern (repeated across
 * features) and keeps a stable subscription: the latest `handler` is held in a
 * ref (updated in an effect) so re-renders with a fresh closure don't
 * re-subscribe, and you don't need to memoize the handler at every call site.
 *
 * For components that bridge several related events into a store in one place
 * (see useTabEvents / useDevtoolsEvents), prefer a single batched useEffect —
 * this hook is for the one-off inline subscriptions.
 */
export function useIpcListener<C extends EventChannel>(
  channel: C,
  handler: (payload: EventPayload<C>) => void,
): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => {
    const off = window.marudesk.on(channel, (payload) => handlerRef.current(payload));
    return () => off();
  }, [channel]);
}
