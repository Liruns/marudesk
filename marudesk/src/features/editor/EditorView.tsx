import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { Ban, Columns2, Eye, FileCode2, FileWarning, Pencil } from 'lucide-react';
import { Spinner } from '../../components/ui';
import { cn } from '../../lib/cn';
import { useTabsStore } from '../tabs/store';
import { isDirty, untitledDocKey, useEditorStore, type FileBuf } from './store';
import { MarkdownPreview } from './MarkdownPreview';

// Monaco is heavy; load it on first file open rather than at app start.
const MonacoView = lazy(() =>
  import('./MonacoView').then((m) => ({ default: m.MonacoView })),
);

type MarkdownMode = 'edit' | 'preview' | 'split';

function isMarkdown(path: string | undefined): boolean {
  if (!path) return false;
  const lower = path.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

/** Small segmented control for Edit / Split / Preview toggle. */
function MarkdownModeToggle({
  mode,
  onChange,
}: {
  mode: MarkdownMode;
  onChange: (m: MarkdownMode) => void;
}) {
  const items: { value: MarkdownMode; Icon: typeof Pencil; label: string }[] = [
    { value: 'edit', Icon: Pencil, label: 'Edit' },
    { value: 'split', Icon: Columns2, label: 'Split' },
    { value: 'preview', Icon: Eye, label: 'Preview' },
  ];

  return (
    <div
      className="flex items-center gap-px rounded bg-surface-2 p-px"
      role="group"
      aria-label="Markdown view mode"
    >
      {items.map(({ value, Icon, label }) => (
        <button
          key={value}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={mode === value}
          onClick={() => onChange(value)}
          className={cn(
            'flex items-center justify-center size-5 rounded-sm transition-colors duration-fast',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-accent',
            mode === value
              ? 'bg-surface-3 text-fg-primary'
              : 'text-fg-tertiary hover:text-fg-secondary',
          )}
        >
          <Icon size={12} />
        </button>
      ))}
    </div>
  );
}

/**
 * The 'editor' tab kind. Resolves the active editor tab's bound file, loads it
 * through the validated workspace:read-file channel, and hands a ready buffer
 * to Monaco. Tabs with no file (opened from a launcher) show a prompt; oversized
 * or binary files are refused with a reason rather than mangled.
 */
export function EditorView({ tabId }: { tabId?: string } = {}) {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  // In the grid a pane pins a specific tab; the single view follows the active
  // tab. `tabId` (when given) wins so each pane resolves its own buffer.
  const resolvedId = tabId ?? activeTabId;
  const tab = tabs.find((t) => t.id === resolvedId);
  const editorTab = tab && tab.kind === 'editor' ? tab : undefined;
  const filePath = editorTab?.filePath;
  const isUntitled = !!editorTab && !filePath;
  // Real files key by path; untitled scratch buffers key by tab id.
  const docKey = editorTab
    ? filePath ?? untitledDocKey(editorTab.id)
    : undefined;

  const ensureLoaded = useEditorStore((s) => s.ensureLoaded);
  const buf = useEditorStore((s) => (docKey ? s.files[docKey] : undefined));

  // View mode for markdown files. Defaults to Split so a .md opens as live
  // edit + rendered preview rather than a wall of plain text; the chosen mode
  // is then remembered across files for the session. A non-markdown buffer
  // always renders as plain Edit. Derived (not reset via an effect) so we don't
  // setState in an effect — react-hooks/set-state-in-effect.
  const [mdMode, setMdMode] = useState<MarkdownMode>('split');
  const isMd = isMarkdown(filePath);
  const mode: MarkdownMode = isMd ? mdMode : 'edit';

  // Editor→preview scroll sync (split mode, best-effort by scroll fraction).
  // A capture-phase scroll listener on the editor pane catches Monaco's
  // internal scrollable element; we pass the fraction to the preview, which
  // applies it imperatively. One-way, so there's no feedback loop to guard.
  const editorPaneRef = useRef<HTMLDivElement | null>(null);
  const [previewScrollRatio, setPreviewScrollRatio] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (mode !== 'split') return;
    const pane = editorPaneRef.current;
    if (!pane) return;
    const onScroll = (e: Event) => {
      const el = e.target as HTMLElement | null;
      if (!el || typeof el.scrollTop !== 'number') return;
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 0) return;
      setPreviewScrollRatio(el.scrollTop / max);
    };
    // Monaco's scrollable element emits non-bubbling scroll events; capture.
    pane.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => pane.removeEventListener('scroll', onScroll, { capture: true });
    // buf?.status is included so the listener (re)attaches once the buffer
    // resolves and the editor pane is actually in the DOM.
  }, [mode, docKey, buf?.status]);

  useEffect(() => {
    if (docKey) void ensureLoaded(docKey);
  }, [docKey, ensureLoaded]);

  if (!docKey) {
    return (
      <Centered
        icon={<FileCode2 size={22} />}
        title="No file open"
        hint="Pick a file in the Explorer, or press Ctrl+N for a new file."
      />
    );
  }
  if (!buf || buf.status === 'loading') {
    return (
      <div className="flex-1 min-w-0 flex items-center justify-center bg-surface-page">
        <Spinner size={18} />
      </div>
    );
  }
  if (buf.status === 'error') return <ErrorState path={docKey} buf={buf} />;

  const label = isUntitled ? editorTab?.title || 'Untitled' : filePath;
  const content = buf.content ?? '';

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-surface-page">
      <header className="h-7 shrink-0 flex items-center gap-2 px-3 border-b border-subtle text-caption">
        <span
          className="truncate text-fg-secondary"
          title={isUntitled ? 'Unsaved file — Ctrl+S to save' : filePath}
        >
          {label}
        </span>
        <span className="flex-1" aria-hidden />
        {isMd && (
          <MarkdownModeToggle mode={mode} onChange={setMdMode} />
        )}
        {buf.saving ? (
          <span className="text-accent">Saving…</span>
        ) : isDirty(buf) ? (
          <span className="flex items-center gap-1 text-fg-secondary">
            <span className="size-1.5 rounded-pill bg-accent" aria-hidden />
            Unsaved
          </span>
        ) : (
          <span className="text-fg-tertiary">Saved</span>
        )}
      </header>

      {/* Body: Monaco / Split / Preview depending on mode */}
      <div className="flex-1 min-h-0 min-w-0 flex">
        {/* Monaco pane — hidden in preview-only mode */}
        {(mode === 'edit' || mode === 'split') && (
          <div
            ref={editorPaneRef}
            className={cn(
              'flex min-h-0 min-w-0',
              mode === 'split' ? 'w-1/2 border-r border-subtle' : 'flex-1',
            )}
          >
            <Suspense
              fallback={
                <div className="flex-1 min-w-0 flex items-center justify-center">
                  <Spinner size={18} />
                </div>
              }
            >
              <MonacoView path={docKey} />
            </Suspense>
          </div>
        )}

        {/* Preview pane — shown in preview and split modes */}
        {isMd && (mode === 'preview' || mode === 'split') && (
          <MarkdownPreview
            content={content}
            scrollRatio={mode === 'split' ? previewScrollRatio : undefined}
            className={cn(
              'min-h-0 bg-surface-page',
              mode === 'split' ? 'w-1/2' : 'flex-1',
            )}
          />
        )}
      </div>
    </div>
  );
}

function ErrorState({ path, buf }: { path: string; buf: FileBuf }) {
  const { title, hint, icon } = describeError(path, buf);
  return <Centered icon={icon} title={title} hint={hint} />;
}

function describeError(
  path: string,
  buf: FileBuf,
): { title: string; hint: string; icon: ReactNode } {
  if (buf.reason === 'too-large') {
    const mb = buf.size ? (buf.size / 1048576).toFixed(1) : '?';
    return {
      title: 'File too large',
      hint: `${path} is ${mb} MB — beyond the editor limit.`,
      icon: <FileWarning size={22} />,
    };
  }
  if (buf.reason === 'binary') {
    return {
      title: 'Binary file',
      hint: `${path} isn't text and can't be edited here.`,
      icon: <Ban size={22} />,
    };
  }
  if (buf.reason === 'not-a-file') {
    return { title: 'Not a file', hint: path, icon: <Ban size={22} /> };
  }
  return {
    title: "Couldn't open file",
    hint: buf.error ?? path,
    icon: <FileWarning size={22} />,
  };
}

function Centered({
  icon,
  title,
  hint,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <div className="flex-1 min-w-0 flex flex-col items-center justify-center gap-3 bg-surface-page text-center px-8">
      <span className="size-12 rounded-lg bg-surface-2 flex items-center justify-center text-fg-tertiary">
        {icon}
      </span>
      <h2 className="text-title text-fg-secondary">{title}</h2>
      <p className="text-body-sm text-fg-tertiary max-w-sm break-all">{hint}</p>
    </div>
  );
}
