import { app, shell } from 'electron';
import { defineHandler } from './ipc/define-handler';
import { clearAllSessions, sessionStats } from './agent/sessions-store';

/**
 * IPC for the Settings → Data & Storage panel (docs/data-storage-design): report
 * which backend the session store uses plus its size, wipe all saved sessions,
 * and reveal the userData folder where the JSON files / SQLite DB live. All of it
 * operates on the trusted userData dir — no workspace path validation applies.
 */
export function registerStorageHandlers(): void {
  defineHandler('storage:stats', () => sessionStats());

  defineHandler('storage:clear-sessions', () => clearAllSessions());

  defineHandler('storage:reveal', () => {
    // Open the userData directory in the OS file manager so a user can inspect
    // or back up the on-disk stores (settings.json, marudesk.db, sessions/…).
    void shell.openPath(app.getPath('userData'));
  });
}
