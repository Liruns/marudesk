import { scrubText } from '../../../shared/scrub';

/**
 * Small internal constants/helpers shared between the devtools store and the
 * extracted CDP-batch reducer (ingest-batch.ts). Kept in their own module so the
 * reducer doesn't have to import back from store.ts (which would create a
 * value-level import cycle).
 */

export const MAX_CONSOLE = 1500;
export const MAX_NETWORK = 1500;
const MAX_NETWORK_PAYLOAD = 64_000;

/**
 * Scrub a captured request/response body and bound it to {@link MAX_NETWORK_PAYLOAD},
 * flagging when it was truncated. Returns null when there's no value to store.
 */
export function boundedNetworkPayload(value: string | undefined): {
  text: string;
  truncated: boolean;
} | null {
  if (value === undefined) return null;
  const scrubbed = scrubText(value);
  if (scrubbed.length <= MAX_NETWORK_PAYLOAD) {
    return { text: scrubbed, truncated: false };
  }
  return {
    text: scrubbed.slice(0, MAX_NETWORK_PAYLOAD),
    truncated: true,
  };
}

let entrySeq = 0;
/** Monotonic id for console/network entries within a session. */
export function entryId(): string {
  return `c${++entrySeq}`;
}
