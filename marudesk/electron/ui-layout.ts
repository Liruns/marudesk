import { app } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { atomicWriteFile } from './fs-safe';
import { defineHandler } from './ipc/define-handler';

/**
 * Persistence for the renderer-owned UI layout (the workspace deck split tree).
 * Stored opaquely as JSON under userData — main doesn't interpret the shape; the
 * renderer sanitizes/reconciles it against the live workspaces on load. This lets
 * the workspace split arrangement survive a restart (tab grid splits reference
 * ephemeral tab ids and are out of scope here).
 */

function layoutFile(): string {
  return path.join(app.getPath('userData'), 'ui-layout.json');
}

export function registerUiLayoutHandlers(): void {
  defineHandler('ui:get-layout', async () => {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(layoutFile(), 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  });

  defineHandler('ui:set-layout', async ([layout]) => {
    try {
      if (layout && typeof layout === 'object') {
        await atomicWriteFile(layoutFile(), JSON.stringify(layout));
      }
    } catch {
      // Best-effort — a failed layout write must never break the UI.
    }
  });
}
