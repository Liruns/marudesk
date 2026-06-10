import { useEffect, useState } from 'react';
import type { UpdateStatus } from '../../shared/app-info';

let listeners = new Set<(s: UpdateStatus) => void>();
let current: UpdateStatus = { kind: 'disabled' };
let subscribed = false;

function subscribe(): void {
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
  for (const fn of listeners) fn(next);
}

export function useUpdateStatus(): UpdateStatus {
  const [status, setStatus] = useState<UpdateStatus>(current);
  useEffect(() => {
    subscribe();
    setStatus(current);
    listeners.add(setStatus);
    return () => {
      listeners.delete(setStatus);
    };
  }, []);
  return status;
}
