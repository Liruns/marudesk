import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Ban, FileCode2, FileWarning } from 'lucide-react';
import { Spinner } from '../../components/ui';
import { useTabsStore } from '../tabs/store';
import { isDirty, untitledDocKey, useEditorStore, type FileBuf } from './store';

// Monaco is heavy; load it on first file open rather than at app start.
const MonacoView = lazy(() =>
  import('./MonacoView').then((m) => ({ default: m.MonacoView })),
);

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
