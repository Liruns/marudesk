import { monaco } from '../editor/monaco-setup';
import type { Diagnostic } from '../../../shared/diagnostics';
import { useDiagnosticsStore } from './store';

/**
 * Project squiggles: project the cached diagnostics onto the Monaco editor as
 * markers (docs/workspace-language-support-design.md, Tier 1). The findings come
 * from the project's OWN checker (tsc/…), so these are the same errors a build
 * would report — unlike Monaco's isolated TS worker, which can't resolve the real
 * project graph. Markers are keyed by file (the model URI path), so only open
 * files get squiggles; the Problems indicator (StatusBar) shows the totals.
 *
 * This module imports monaco, so it loads with the editor surface — call
 * {@link ensureDiagnosticMarkers} from the editor (MonacoView), not the shell, to
 * keep Monaco out of the shell bundle.
 */

const OWNER = 'marudesk-diagnostics';
let installed = false;

function severityOf(s: Diagnostic['severity']): monaco.MarkerSeverity {
  if (s === 'error') return monaco.MarkerSeverity.Error;
  if (s === 'warning') return monaco.MarkerSeverity.Warning;
  return monaco.MarkerSeverity.Info;
}

/** Models are created with URI path `/<workspace-relative path>` (monaco-setup). */
function relPath(model: monaco.editor.ITextModel): string {
  return model.uri.path.replace(/^\//, '');
}

function markersFor(file: string, diags: readonly Diagnostic[]): monaco.editor.IMarkerData[] {
  const out: monaco.editor.IMarkerData[] = [];
  for (const d of diags) {
    if (d.file !== file) continue;
    out.push({
      severity: severityOf(d.severity),
      message: d.code ? `${d.message} (${d.code})` : d.message,
      source: d.source,
      startLineNumber: d.line,
      startColumn: d.column,
      endLineNumber: d.endLine ?? d.line,
      endColumn: d.endColumn ?? d.column + 1,
    });
  }
  return out;
}

function applyToModel(model: monaco.editor.ITextModel, diags: readonly Diagnostic[]): void {
  monaco.editor.setModelMarkers(model, OWNER, markersFor(relPath(model), diags));
}

function applyAll(diags: readonly Diagnostic[]): void {
  for (const model of monaco.editor.getModels()) applyToModel(model, diags);
}

/**
 * Install the diagnostics→markers projection once (idempotent). Applies to
 * already-open models, models opened later, and re-applies on every diagnostics
 * change. Lives for the app's lifetime — no disposer needed.
 */
export function ensureDiagnosticMarkers(): void {
  if (installed) return;
  installed = true;
  const current = (): readonly Diagnostic[] =>
    useDiagnosticsStore.getState().state.lastRun?.diagnostics ?? [];
  monaco.editor.onDidCreateModel((model) => applyToModel(model, current()));
  useDiagnosticsStore.subscribe((s) => applyAll(s.state.lastRun?.diagnostics ?? []));
  applyAll(current());
}
