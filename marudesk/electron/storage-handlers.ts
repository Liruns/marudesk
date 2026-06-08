import { app, shell } from 'electron';
import { defineHandler } from './ipc/define-handler';
import { nonEmptyStr, obj } from './ipc/validate';
import { clearAllSessions, sessionStats } from './agent/sessions-store';
import {
  deleteMemory,
  listMemory,
  readMemory,
  searchMemory,
  writeMemory,
} from './agent/memory-store';

/**
 * IPC for the Settings → Data & Storage panel (docs/data-storage-design): report
 * which backend the session store uses plus its size, wipe all saved sessions,
 * and reveal the userData folder where the JSON files / SQLite DB live. All of it
 * operates on the trusted userData dir — no workspace path validation applies.
 *
 * Also the memory controls (v5 §G5): list/read/write/delete the agent's
 * remembered notes — the user-facing twin of the agent's own memory tools.
 */
export function registerStorageHandlers(): void {
  defineHandler('storage:stats', () => sessionStats());

  defineHandler('storage:clear-sessions', () => clearAllSessions());

  defineHandler('storage:reveal', () => {
    // Open the userData directory in the OS file manager so a user can inspect
    // or back up the on-disk stores (settings.json, marudesk.db, sessions/…).
    void shell.openPath(app.getPath('userData'));
  });

  defineHandler('memory:list', () => listMemory());

  defineHandler('memory:search', ([payload]) => {
    const p = obj(payload);
    return searchMemory(typeof p.query === 'string' ? p.query : '');
  });

  defineHandler('memory:read', ([payload]) =>
    readMemory(nonEmptyStr(obj(payload).name, 'name')),
  );

  defineHandler('memory:write', ([payload]) => {
    const p = obj(payload);
    const body = typeof p.body === 'string' ? p.body : '';
    return writeMemory(nonEmptyStr(p.name, 'name'), body);
  });

  defineHandler('memory:delete', ([payload]) =>
    deleteMemory(nonEmptyStr(obj(payload).name, 'name')),
  );
}
