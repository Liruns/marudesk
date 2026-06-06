import type { BrowserWindow } from 'electron';
import { defineHandler, requireWorkspace } from '../ipc/define-handler';
import { getDiagnosticsState, runDiagnostics, setDiagnosticsListener } from './runner';

/**
 * IPC surface for workspace diagnostics (docs/workspace-language-support-design.md,
 * Tier 1). `diagnostics:run` is the human/renderer trigger (a "Check" button /
 * on-save) — it runs the project's own checker; `diagnostics:get` is the pull for
 * initial render. Live results are pushed on `diagnostics:update` as a pass starts
 * and finishes, so the Problems panel and Monaco markers update without polling.
 *
 * Running a checker executes the project's tooling, but this is user-initiated
 * (clicking Check, like a build button) — distinct from the agent's run_command,
 * which is per-call AI-approved. The agent reads these results read-only via the
 * read_diagnostics tool.
 */
export function registerDiagnosticsHandlers(deps: {
  getMainWindow: () => BrowserWindow | null;
}): void {
  setDiagnosticsListener((state) => {
    const win = deps.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('diagnostics:update', state);
  });

  defineHandler('diagnostics:run', async () => {
    const { root } = requireWorkspace();
    return runDiagnostics(root);
  });

  defineHandler('diagnostics:get', () => {
    const { root } = requireWorkspace();
    return getDiagnosticsState(root);
  });
}
