import type { Transport } from './types';
import { StubTransport } from './StubTransport';
import { RelayTransport } from './RelayTransport';

export type { Transport, TransportStatus, TransportStatusInfo, TransportCommand, TransportCommandArgs } from './types';
export { StubTransport } from './StubTransport';
export { RelayTransport } from './RelayTransport';

/**
 * The single switch between the demo fake and the real relay client.
 *
 * DEFAULT = StubTransport so the whole app stays runnable/demoable (and the smoke
 * test deterministic) with no relay or PC. Set `VITE_USE_RELAY=true` to use the
 * live {@link RelayTransport} against a running relay + PC host (Bridge Model B).
 * Reading it from the env (rather than a hardcoded flag) lets a real build opt in
 * without a code edit, while dev/test keep the fake.
 */
function useRelay(): boolean {
  const env = import.meta.env as Record<string, string | undefined>;
  return env.VITE_USE_RELAY === 'true' || env.VITE_USE_RELAY === '1';
}

export function createTransport(): Transport {
  return useRelay() ? new RelayTransport() : new StubTransport();
}
