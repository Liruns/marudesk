import type { WorkspaceId } from '../../../shared/workspace';
import { SearchPanel } from './SearchPanel';

/**
 * Mission Control's full-area Search instrument. Hosts {@link SearchPanel} in its
 * embedded layout (no rail chrome, no close handle) — InstrumentStage provides the
 * surrounding frame and the "← Graph" affordance. Opening a match summons the
 * file's editor instrument in place.
 *
 * `workspaceId` is the hosting tab's bound workspace: opening a match resolves the
 * file against THAT workspace rather than the global active one. Absent (the
 * coincident ⌘K case) it falls back to the active workspace, so today's behavior
 * is unchanged. (The result list itself is scoped by main's active workspace via
 * search:content, which takes no per-call workspaceId.)
 */
export function SearchInstrument({ workspaceId }: { workspaceId?: WorkspaceId }) {
  return <SearchPanel embedded open workspaceId={workspaceId} />;
}
