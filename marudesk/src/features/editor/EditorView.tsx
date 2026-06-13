import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { FileCode2, FileImage } from 'lucide-react';
import { Spinner } from '../../components/ui';
import { cn } from '../../lib/cn';
import { useI18n } from '../../i18n/useI18n';
import { useTabsStore } from '../tabs/store';
import { editorDocKeyForTab, isDirty, useEditorStore } from './store';
import { MarkdownPreview } from './MarkdownPreview';
import {
  EditorEmptyState,
  EditorErrorState,
  EditorFooter,
  EditorMarkdownModeToggle,
  type MarkdownMode,
} from './editorI18n';

/** What MonacoView reports up for the status bar. */
export type EditorStatus = { line: number; column: number; language: string };

// Monaco is heavy; load it on first file open rather than at app start.
const MonacoView = lazy(() =>
  import('./MonacoView').then((m) => ({ default: m.MonacoView })),
);

function isMarkdown(path: string | undefined): boolean {
  if (!path) return false;
  const lower = path.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

/**
 * The 'editor' tab kind. Resolves the active editor tab's bound file, loads it
 * through the validated workspace:read-file channel, and hands a ready buffer
 * to Monaco. Tabs with no file (opened from a launcher) show a prompt; oversized
 * or binary files are refused with a reason rather than mangled.
 */
export function EditorView({ tabId }: { tabId?: string } = {}) {
  const { t } = useI18n();
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  // In the grid a pane pins a specific tab; the single view follows the active
  // tab. `tabId` (when given) wins so each pane resolves its own buffer.
  const resolvedId = tabId ?? activeTabId;
  const tab = tabs.find((t) => t.id === resolvedId);
  const editorTab = tab && tab.kind === 'editor' ? tab : undefined;
  const fileRef = editorTab?.editorFile;
  const filePath = fileRef?.path ?? editorTab?.filePath;
  const isUntitled = !!editorTab && !filePath;
  const docKey = editorTab ? editorDocKeyForTab(editorTab) ?? undefined : undefined;

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
  const [editorScrollRatio, setEditorScrollRatio] = useState<number | undefined>(undefined);
  // Echo guard for the two-way split-scroll sync: MonacoView flips this true just
  // before it applies a preview-driven scroll, so the scroll event that fires
  // back here is recognised as our own and not bounced to the preview (which
  // would ping-pong the two panes). MarkdownPreview guards its side the same way.
  const editorScrollApplyingRef = useRef(false);
  // Status-bar state lifted from Monaco (cursor + language) plus the word-wrap
  // toggle, which is owned here and pushed down so the footer button can flip it.
  const [status, setStatus] = useState<EditorStatus>({ line: 1, column: 1, language: 'plaintext' });
  const [wordWrap, setWordWrap] = useState(false);
  useEffect(() => {
    if (mode !== 'split') return;
    const pane = editorPaneRef.current;
    if (!pane) return;
    const onScroll = (e: Event) => {
      if (editorScrollApplyingRef.current) {
        editorScrollApplyingRef.current = false;
        return;
      }
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
    if (!docKey) return;
    void ensureLoaded(fileRef ?? docKey);
  }, [docKey, ensureLoaded, fileRef]);

  if (!docKey) {
    return <EditorEmptyState />;
  }
  if (!buf || buf.status === 'loading') {
    return (
      <div className="flex-1 min-w-0 flex items-center justify-center bg-surface-page">
        <Spinner size={18} />
      </div>
    );
  }
  if (buf.status === 'error') return <EditorErrorState path={docKey} buf={buf} />;

  const label = isUntitled
    ? editorTab?.title || t('editor.header.untitled')
    : editorTab?.title || filePath;
  const content = buf.kind === 'text' ? buf.content : '';
  const HeaderIcon = buf.kind === 'image' ? FileImage : FileCode2;

  return (
    <div className="@container flex-1 min-w-0 min-h-0 flex flex-col bg-surface-page">
      {/* Header on surface-2 — the active tab's tone — so the editor's chrome
          reads as one surface flowing out of its tab, matching the browser. */}
      <header className="h-7 shrink-0 flex items-center gap-1 px-2 @[18rem]:gap-2 @[18rem]:px-3 border-b border-subtle text-caption bg-surface-2">
        <HeaderIcon size={13} className="shrink-0 text-fg-tertiary" aria-hidden />
        <span
          className="truncate text-fg-secondary"
          title={isUntitled ? t('editor.header.unsavedTitle') : filePath}
        >
          {label}
        </span>
        <span className="flex-1" aria-hidden />
        {isMd && (
          <span className="hidden @[20rem]:flex">
            <EditorMarkdownModeToggle mode={mode} onChange={setMdMode} />
          </span>
        )}
        {buf.kind === 'image' ? (
          <span className="text-fg-tertiary">{t('editor.image.preview')}</span>
        ) : buf.saving ? (
          <span className="text-accent">{t('editor.state.saving')}</span>
        ) : isDirty(buf) ? (
          <span className="flex items-center gap-1 text-fg-secondary">
            <span className="size-1.5 rounded-pill bg-accent" aria-hidden />
            {t('editor.state.unsaved')}
          </span>
        ) : (
          <span className="text-fg-tertiary">{t('editor.state.saved')}</span>
        )}
      </header>

      {buf.kind === 'image' ? (
        <ImagePreview path={filePath ?? docKey} dataUrl={buf.dataUrl} />
      ) : (
        <div className="flex-1 min-h-0 min-w-0 flex flex-col @[30rem]:flex-row">
          {(mode === 'edit' || mode === 'split') && (
            <div
              ref={editorPaneRef}
              className={cn(
                'flex min-h-0 min-w-0',
                mode === 'split'
                  ? 'w-full @[30rem]:w-1/2 @[30rem]:border-r @[30rem]:border-subtle'
                  : 'flex-1',
              )}
            >
              <Suspense
                fallback={
                  <div className="flex-1 min-w-0 flex items-center justify-center">
                    <Spinner size={18} />
                  </div>
                }
              >
                <MonacoView
                  path={docKey}
                  wordWrap={wordWrap}
                  onStatus={setStatus}
                  scrollRatio={mode === 'split' ? editorScrollRatio : undefined}
                  scrollApplyingRef={editorScrollApplyingRef}
                />
              </Suspense>
            </div>
          )}

          {isMd && (mode === 'preview' || mode === 'split') && (
            <MarkdownPreview
              content={content}
              scrollRatio={mode === 'split' ? previewScrollRatio : undefined}
              onScrollRatio={mode === 'split' ? setEditorScrollRatio : undefined}
              className={cn(
                'min-h-0 bg-surface-page',
                mode === 'split' ? 'hidden @[30rem]:block @[30rem]:w-1/2' : 'flex-1',
              )}
            />
          )}
        </div>
      )}

      {buf.kind === 'image' ? (
        <ImageFooter mediaType={buf.mediaType} size={buf.size} />
      ) : mode !== 'preview' ? (
        <EditorFooter
          line={status.line}
          column={status.column}
          language={status.language}
          wordWrap={wordWrap}
          onToggleWordWrap={() => setWordWrap((w) => !w)}
        />
      ) : null}
    </div>
  );
}

function ImagePreview({ path, dataUrl }: { path: string; dataUrl: string }) {
  return (
    <div className="flex-1 min-h-0 min-w-0 flex items-center justify-center overflow-auto bg-surface-page p-6">
      <img
        src={dataUrl}
        alt={path}
        className="max-w-full max-h-full object-contain"
      />
    </div>
  );
}

function ImageFooter({
  mediaType,
  size,
}: {
  mediaType: string;
  size: number;
}) {
  const sizeLabel =
    size < 1024
      ? `${size} B`
      : size < 1024 * 1024
        ? `${(size / 1024).toFixed(1)} KB`
        : `${(size / (1024 * 1024)).toFixed(1)} MB`;

  return (
    <footer className="h-6 shrink-0 flex items-center gap-3 px-3 border-t border-subtle bg-surface-2 text-caption text-fg-tertiary tabular-nums select-none">
      <span>{mediaType}</span>
      <span>{sizeLabel}</span>
    </footer>
  );
}
