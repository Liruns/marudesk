import { test } from '@playwright/test';

/**
 * Workspace management UI — REMOVED in the Mission Control redesign.
 *
 * The Task graph is now the only home (docs/mission-control-redesign.md). The
 * surfaces this spec used to drive are gone:
 *   - the "Workspace rail" navigation (which exposed the per-workspace
 *     rename/delete context menu), and
 *   - the "Peek Explorer" button + the "Explorer" complementary panel (which
 *     exposed the per-root "remove folder from workspace" controls).
 *
 * The workspace store still carries `renameWorkspace` / `deleteWorkspace` /
 * `removeRoot` actions (src/features/workspaces/store.ts) and the matching
 * `workspaces:*` IPC, but Mission Control renders no UI that invokes them: the
 * title bar's ProfileSwitcher manages *profiles* (isolated userData), not
 * *workspaces*, and there is no rail / explorer surface anywhere in the Shell.
 *
 * There is therefore no Mission Control entry point to reach these flows, so the
 * three former tests (rail rename/delete, Peek Explorer root removal, explorer
 * root context-menu removal) have no surviving surface to exercise. They are
 * deleted; this annotated placeholder records why and keeps the file from being
 * an empty suite. Restore real coverage if/when a workspace-management surface
 * returns to the home.
 */
test.skip('workspace management UI removed in Mission Control redesign', () => {
  // No-op: the Workspace rail and Peek Explorer / Explorer panels no longer
  // exist, so workspace rename/delete and folder-root removal have no UI to
  // drive. The underlying workspaces:* IPC is covered by the main-process
  // harnesses, not by an e2e UI flow.
});
