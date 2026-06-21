import type { WorkspaceId } from '../../../shared/workspace';
import { ExplorerPanel } from './ExplorerPanel';

/**
 * Files (the workspace explorer) as a Mission Control full-area instrument.
 * InstrumentStage hosts this surface and owns the "← Graph" back affordance, so
 * the panel renders in `embedded` mode (no rail chrome: fixed width, collapse,
 * or drag-to-close) and always open — there's nothing to request-close to here.
 *
 * `workspaceId` is the hosting tab's bound workspace: when present the tree
 * resolves THAT workspace instead of the global active one. Absent (the
 * coincident ⌘K case, which passes the active id) it falls back to the active
 * workspace, so today's behavior is unchanged.
 */
export function FilesInstrument({ workspaceId }: { workspaceId?: WorkspaceId }) {
  return <ExplorerPanel embedded open workspaceId={workspaceId} />;
}
