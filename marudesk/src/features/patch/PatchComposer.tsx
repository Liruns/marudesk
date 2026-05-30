import { useMemo } from 'react';
import { Eye, FolderOpen, Play, RotateCcw } from 'lucide-react';
import { Badge, Button } from '../../components/ui';
import { cn } from '../../lib/cn';
import { useWorkspaceStore } from '../workspace/store';
import { usePatchStore } from './store';
import { PatchPreviewView } from './PatchPreviewView';

const PLACEHOLDER = `[
  {
    "path": "src/example.ts",
    "oldString": "const greeting = 'hello';",
    "newString": "const greeting = 'hello world';"
  }
]`;

export function PatchComposer() {
  const summary = useWorkspaceStore((s) => s.summary);
  const opening = useWorkspaceStore((s) => s.opening);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);

  const opsText = usePatchStore((s) => s.opsText);
  const parseError = usePatchStore((s) => s.parseError);
  const preview = usePatchStore((s) => s.preview);
  const previewing = usePatchStore((s) => s.previewing);
  const applying = usePatchStore((s) => s.applying);
  const lastResult = usePatchStore((s) => s.lastResult);
  const setOpsText = usePatchStore((s) => s.setOpsText);
  const runPreview = usePatchStore((s) => s.runPreview);
  const runApply = usePatchStore((s) => s.runApply);
  const reset = usePatchStore((s) => s.reset);

  const canPreview = useMemo(
    () => opsText.trim().length > 0 && !previewing && !!summary,
    [opsText, previewing, summary],
  );
  const canApply =
    !!preview && !preview.hasErrors && !applying && !previewing && !!summary;

  return (
    <div className="h-screen flex flex-col bg-surface-page text-fg-primary">
      <header className="h-12 shrink-0 flex items-center justify-between gap-4 px-4 bg-surface-1 border-b border-subtle">
        <div className="flex items-center gap-3 min-w-0">
          <span
            aria-hidden="true"
            className="size-5 rounded bg-accent shrink-0"
          />
          <span className="text-body-sm font-medium tracking-tight shrink-0">
            marudesk
          </span>
          <span className="text-fg-tertiary text-body-sm shrink-0">/</span>
          <span className="text-fg-secondary text-body-sm shrink-0">
            dev / patch
          </span>
          {summary ? (
            <>
              <span className="text-fg-tertiary text-body-sm shrink-0">·</span>
              <span
                className="text-body-sm text-fg-secondary truncate"
                title={summary.root}
              >
                {summary.name}
              </span>
              <Badge variant="neutral">{summary.source}</Badge>
            </>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              window.location.hash = '/';
            }}
          >
            Back to shell
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<FolderOpen size={14} />}
            onClick={() => void openWorkspace()}
            disabled={opening}
          >
            {summary ? 'Change' : 'Open workspace'}
          </Button>
        </div>
      </header>

      <main className="flex-1 min-h-0 grid grid-cols-2 gap-0">
        <section className="flex flex-col min-h-0 border-r border-subtle">
          <header className="h-10 shrink-0 flex items-center justify-between px-4 bg-surface-1 border-b border-subtle">
            <span className="text-caption uppercase tracking-wider text-fg-tertiary">
              Ops (JSON)
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                leadingIcon={<RotateCcw size={14} />}
                onClick={() => reset()}
                disabled={previewing || applying}
              >
                Reset
              </Button>
              <Button
                variant="secondary"
                size="sm"
                leadingIcon={<Eye size={14} />}
                onClick={() => void runPreview()}
                disabled={!canPreview}
              >
                {previewing ? 'Previewing…' : 'Preview'}
              </Button>
              <Button
                variant="primary"
                size="sm"
                leadingIcon={<Play size={14} />}
                onClick={() => void runApply()}
                disabled={!canApply}
              >
                {applying ? 'Applying…' : 'Apply'}
              </Button>
            </div>
          </header>
          <textarea
            value={opsText}
            onChange={(e) => setOpsText(e.target.value)}
            placeholder={PLACEHOLDER}
            spellCheck={false}
            className={cn(
              'flex-1 min-h-0 w-full resize-none bg-surface-page p-4',
              'font-mono text-body-sm text-fg-primary placeholder:text-fg-tertiary',
              'tabular-nums leading-relaxed',
              'focus:outline-none',
            )}
            aria-label="Patch ops JSON"
          />
          {parseError ? (
            <div className="border-t border-subtle bg-error-subtle/40 text-body-sm text-fg-secondary px-4 py-2 break-words">
              {parseError}
            </div>
          ) : null}
        </section>

        <section className="flex flex-col min-h-0">
          <header className="h-10 shrink-0 flex items-center justify-between px-4 bg-surface-1 border-b border-subtle">
            <span className="text-caption uppercase tracking-wider text-fg-tertiary">
              Preview
            </span>
            {preview ? (
              <span className="text-caption text-fg-tertiary tabular-nums">
                {preview.ops.length} op{preview.ops.length === 1 ? '' : 's'}
                {preview.hasErrors ? ' · errors' : ''}
              </span>
            ) : null}
          </header>
          <div className="flex-1 min-h-0 overflow-y-auto p-4">
            {!summary ? (
              <div className="text-body-sm text-fg-tertiary">
                Open a workspace to preview patches.
              </div>
            ) : !preview ? (
              <div className="text-body-sm text-fg-tertiary">
                Paste JSON ops on the left, then click Preview. Each op needs{' '}
                <span className="font-mono text-fg-secondary">path</span>,{' '}
                <span className="font-mono text-fg-secondary">oldString</span>,{' '}
                <span className="font-mono text-fg-secondary">newString</span>.
                Empty oldString plus non-empty newString creates a new file.
              </div>
            ) : (
              <PatchPreviewView preview={preview} />
            )}
          </div>
          {lastResult ? (
            <div
              className={cn(
                'border-t border-subtle px-4 py-2 text-body-sm break-words',
                lastResult.ok
                  ? 'bg-success-subtle/40 text-fg-secondary'
                  : 'bg-error-subtle/40 text-fg-secondary',
              )}
            >
              {lastResult.ok ? (
                <>Applied {lastResult.applied.length} op(s).</>
              ) : (
                <>
                  Apply failed
                  {lastResult.errors.length > 0
                    ? `: ${lastResult.errors
                        .map((e) => `${e.path} — ${e.reason}`)
                        .join('; ')}`
                    : '.'}
                </>
              )}
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}
