import { useSyncExternalStore } from 'react';
import type { UpdateStatus } from '../../shared/app-info';

const listeners = new Set<() => void>();
let current: UpdateStatus = { kind: 'disabled' };
let subscribed = false;

/** Lazily hook the module store up to main's update-status push (once). */
function connect(): void {
  if (subscribed) return;
  subscribed = true;
  void window.marudesk
    .invoke('app:update-status')
    .then((s) => broadcast(s))
    .catch(() => {});
  window.marudesk.on('app:update-status-changed', (s) => broadcast(s));
}

function broadcast(next: UpdateStatus): void {
  current = next;
  for (const fn of listeners) fn();
}

function subscribe(onStoreChange: () => void): () => void {
  connect();
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot(): UpdateStatus {
  return current;
}

export function useUpdateStatus(): UpdateStatus {
  return useSyncExternalStore(subscribe, getSnapshot);
}
