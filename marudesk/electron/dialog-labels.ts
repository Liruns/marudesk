import type { DialogLabels } from '../shared/app-info';

/**
 * Cached, localized titles for the native file dialogs the main process opens.
 * The dialogs are constructed in main (no i18n access), so the renderer pushes
 * these on mount + locale change (`app:set-dialog-labels`); until then — and as a
 * per-field fallback for a malformed push — the English defaults apply. Same
 * single-source-of-truth pattern as the tray + web-context-menu labels.
 */
const DEFAULT_DIALOG_LABELS: DialogLabels = {
  saveAs: 'Save As',
  openWorkspace: 'Open workspace',
  addFolder: 'Add folder to workspace',
  installPlugin: 'Install plugin from folder',
};

let labels: DialogLabels = DEFAULT_DIALOG_LABELS;

/** Coerce the untrusted renderer payload field-by-field, defaulting to English. */
export function setDialogLabels(raw: unknown): void {
  const src = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const pick = (key: keyof DialogLabels): string =>
    typeof src[key] === 'string' && src[key] !== '' ? (src[key] as string) : DEFAULT_DIALOG_LABELS[key];
  labels = {
    saveAs: pick('saveAs'),
    openWorkspace: pick('openWorkspace'),
    addFolder: pick('addFolder'),
    installPlugin: pick('installPlugin'),
  };
}

export function getDialogLabels(): DialogLabels {
  return labels;
}
