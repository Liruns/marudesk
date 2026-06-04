import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { FileCode2 } from 'lucide-react';
import { Spinner } from '../../components/ui';
import { cn } from '../../lib/cn';
import { useI18n } from '../../i18n/useI18n';
import { useTabsStore } from '../tabs/store';
import { isDirty, untitledDocKey, useEditorStore } from './store';
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
    if (docKey) void ensureLoaded(docKey);
  }, [docKey, ensureLoaded]);

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

  const label = isUntitled ? editorTab?.title || t('editor.header.untitled') : filePath;
  const content = buf.content ?? '';

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-surface-page">
      {/* Header on surface-2 — the active tab's tone — so the editor's chrome
          reads as one surface flowing out of its tab, matching the browser. */}
      <header className="h-7 shrink-0 flex items-center gap-2 px-3 border-b border-subtle text-caption bg-surface-2">
        <FileCode2 size={13} className="shrink-0 text-fg-tertiary" aria-hidden />
        <span
          className="truncate text-fg-secondary"
          title={isUntitled ? t('editor.header.unsavedTitle') : filePath}
        >
          {label}
        </span>
        <span className="flex-1" aria-hidden />
        {isMd && (
          <EditorMarkdownModeToggle mode={mode} onChange={setMdMode} />
        )}
        {buf.saving ? (
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

        {/* Preview pane — shown in preview and split modes */}
        {isMd && (mode === 'preview' || mode === 'split') && (
          <MarkdownPreview
            content={content}
            scrollRatio={mode === 'split' ? previewScrollRatio : undefined}
            onScrollRatio={mode === 'split' ? setEditorScrollRatio : undefined}
            className={cn(
              'min-h-0 bg-surface-page',
              mode === 'split' ? 'w-1/2' : 'flex-1',
            )}
          />
        )}
      </div>

      {/* Status bar — only while a Monaco pane is mounted (edit/split). */}
      {mode !== 'preview' ? (
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
