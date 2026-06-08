/**
 * Renderer-facing re-export of the shared {@link toMessage} helper. The canonical
 * implementation lives in `shared/to-message.ts` so the main process and renderer
 * agree on how thrown values become display strings; this keeps the existing
 * `@/lib/toMessage` import path stable for renderer call sites.
 */
export { toMessage } from '../../shared/to-message';
