import type { Transport } from './types';
import { StubTransport } from './StubTransport';
import { RelayTransport } from './RelayTransport';

export type { Transport, TransportStatus, TransportStatusInfo, TransportCommand, TransportCommandArgs } from './types';
export { StubTransport } from './StubTransport';
export { RelayTransport } from './RelayTransport';

/**
 * Which transport backs the relay sign-in path. (Direct mode is unaffected —
 * the store installs `DirectTransport` itself once a PC pairing is stored.)
 *
 *  - `VITE_USE_STUB=true`  → the in-memory demo fake, regardless of build mode.
 *  - `VITE_USE_RELAY=true` → the live relay client, regardless of build mode.
 *  - otherwise             → dev serves the stub (demoable with no relay/PC);
 *                            a production build uses the REAL relay client, so
 *                            a shipped app can never sign a user into a fake
 *                            demo chat.
 */
function flag(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

export function createTransport(): Transport {
  const env = import.meta.env as Record<string, string | undefined>;
  if (flag(env.VITE_USE_STUB)) return new StubTransport();
  if (flag(env.VITE_USE_RELAY)) return new RelayTransport();
  return import.meta.env.PROD ? new RelayTransport() : new StubTransport();
}
