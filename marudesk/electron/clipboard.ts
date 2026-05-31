import { clipboard } from 'electron';
import { defineHandler } from './ipc/define-handler';

/**
 * Clipboard bridge for the integrated terminal's copy/paste. The renderer can't
 * reliably reach the OS clipboard from a sandboxed context (read in particular
 * is permission-gated), so xterm copy/paste goes through main's `clipboard`
 * module instead. Trusted-renderer only — embedded web content has no
 * `marudesk` bridge, so it can't reach these channels.
 */
export function registerClipboardHandlers(): void {
  defineHandler('clipboard:write-text', ([raw]) => {
    if (typeof raw === 'string' && raw.length > 0) clipboard.writeText(raw);
  });

  defineHandler('clipboard:read-text', () => clipboard.readText());
}
