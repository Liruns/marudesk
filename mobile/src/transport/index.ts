import type { Transport } from './types';
import { StubTransport } from './StubTransport';
import { RelayTransport } from './RelayTransport';

export type { Transport, TransportStatus, TransportStatusInfo, TransportCommand, TransportCommandArgs } from './types';
export { StubTransport } from './StubTransport';
export { RelayTransport } from './RelayTransport';

/**
 * The single switch between the demo fake and the (pending-B2) real relay.
 *
 * DEFAULT = StubTransport so the whole app is runnable/demoable with no relay or
 * PC. Flip `USE_RELAY` to true (or wire it to an env flag) once the B2 PC-side
 * bridge lands and `RelayTransport` is implemented per its header seam note.
 */
const USE_RELAY = false;

export function createTransport(): Transport {
  return USE_RELAY ? new RelayTransport() : new StubTransport();
}
