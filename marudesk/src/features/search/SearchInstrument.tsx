import type { WorkspaceId } from '../../../shared/workspace';
import { SearchPanel } from './SearchPanel';

/**
 * Mission Control's full-area Search instrument. Hosts {@link SearchPanel} in its
 * embedded layout (no rail chrome, no close handle) — InstrumentStage provides the
 * surrounding frame and the "← Graph" affordance. Opening a match summons the
 * file's editor instrument in place.
 *
 * `workspaceId` is the hosting tab's bound workspace: both the result list and
 * opening a match resolve against THAT workspace's active root rather than the
 * global active one — the panel threads it into search:content's opts so the
 * listed paths and the opened file refs share a root. Absent (the coincident ⌘K
 * case) it falls back to the active workspace, so today's behavior is unchanged.
 */
export function SearchInstrument({ workspaceId }: { workspaceId?: WorkspaceId }) {
  return <SearchPanel embedded open workspaceId={workspaceId} />;
}
