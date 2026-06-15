import { monaco } from './monaco-setup';
import type {
  GitBlameFile,
  GitBlameLine,
  GitFileDiffLines,
} from '../../../shared/git';
import type { WorkspaceFileRef } from '../../../shared/workspace';
import { getMessage } from '../../i18n/messages';
import { currentLocale } from '../../i18n/locale-storage';
import { isTextFileBuf } from './buffer';
import { isDirty, useEditorStore } from './store';
import { relativeTime } from '../git/statusMeta';

/**
 * Git decorations for the single Monaco editor instance (MonacoView):
 *   - a diff gutter (added/modified bars + deletion triangles vs HEAD), fed by
 *     the `git:file-diff-lines` channel;
 *   - GitLens-style inline blame on the CURRENT cursor line only, fed by
 *     `git:blame-file` and cached per saved file content.
 *
 * MonacoView owns the lifecycle: it constructs one controller per editor and
 * calls the on* hooks from its existing listeners (model bind, cursor moves,
 * content changes, saves, git-store refreshes). All fetches are sequenced so a
 * stale response can never paint over a newer document. CSS classes live in
 * editor-git.css and use design-token variables only.
 */

const DIFF_DEBOUNCE_MS = 250;

function isUntitledDocKey(key: string): boolean {
  return key.startsWith('untitled-');
}

const UNCOMMITTED_HASH = /^0+$/;

/** "author, relative time · summary" (or the localized uncommitted label). */
function formatBlame(entry: GitBlameLine): string {
  if (UNCOMMITTED_HASH.test(entry.hash)) {
    return getMessage(currentLocale(), 'editor.blame.uncommitted');
  }
  const rel = relativeTime(entry.authorTime * 1000);
  const summary = entry.summary.trim();
  return summary
    ? `${entry.author}, ${rel} · ${summary}`
    : `${entry.author}, ${rel}`;
}

type BlameCacheEntry = { saved: string; lines: GitBlameLine[] | null };

export class GitEditorDecorations {
  private readonly editor: monaco.editor.IStandaloneCodeEditor;
  private readonly gutter: monaco.editor.IEditorDecorationsCollection;
  private readonly blame: monaco.editor.IEditorDecorationsCollection;
  private docKey = '';
  private blameEnabled = true;
  private diffTimer: ReturnType<typeof setTimeout> | null = null;
  private diffSeq = 0;
  private blameSeq = 0;
  /** Per-doc blame, valid only for the exact `saved` content it was computed for. */
  private readonly blameCache = new Map<string, BlameCacheEntry>();
  /** The blame fetch currently in flight, so cursor moves don't re-spam IPC. */
  private blamePending: { key: string; saved: string } | null = null;
  private disposed = false;

  constructor(editor: monaco.editor.IStandaloneCodeEditor) {
    this.editor = editor;
    this.gutter = editor.createDecorationsCollection();
    this.blame = editor.createDecorationsCollection();
  }

  /** Bind to a new document: drop stale paint, then refetch for the new one. */
  setDocKey(key: string): void {
    if (key === this.docKey) return;
    this.docKey = key;
    this.gutter.clear();
    this.blame.clear();
    this.scheduleDiffRefresh();
    void this.updateBlame();
  }

  /** Live "Inline blame" setting. Turning it off clears immediately. */
  setBlameEnabled(on: boolean): void {
    if (on === this.blameEnabled) return;
    this.blameEnabled = on;
    if (on) void this.updateBlame();
    else this.blame.clear();
  }

  /** The current document was saved: re-diff and re-blame the fresh content. */
  onSaved(): void {
    this.blameCache.delete(this.docKey);
    this.scheduleDiffRefresh();
    void this.updateBlame();
  }

  /** Git state changed externally (commit/stage/discard/branch switch). */
  onGitStateChanged(): void {
    this.blameCache.clear();
    this.scheduleDiffRefresh();
    void this.updateBlame();
  }

  /** Cursor moved: the blame annotation follows the current line. */
  onCursorChanged(): void {
    void this.updateBlame();
  }

  /** Buffer text changed: hide blame while dirty (no mid-typing flicker). */
  onContentChanged(): void {
    void this.updateBlame();
  }

  dispose(): void {
    this.disposed = true;
    if (this.diffTimer !== null) clearTimeout(this.diffTimer);
    this.gutter.clear();
    this.blame.clear();
  }

  /** The IPC payload for the bound doc (multi-root ref when one is known). */
  private payload(key: string): { path: string; file?: WorkspaceFileRef } {
    const ref = useEditorStore.getState().fileRefs[key];
    return ref ? { path: ref.path, file: ref } : { path: key };
  }

  private scheduleDiffRefresh(): void {
    if (this.diffTimer !== null) clearTimeout(this.diffTimer);
    this.diffTimer = setTimeout(() => {
      this.diffTimer = null;
      void this.refreshDiff();
    }, DIFF_DEBOUNCE_MS);
  }

  private async refreshDiff(): Promise<void> {
    const key = this.docKey;
    if (!key || isUntitledDocKey(key)) {
      this.gutter.clear();
      return;
    }
    const seq = ++this.diffSeq;
    let res: GitFileDiffLines;
    try {
      res = await window.marudesk.invoke('git:file-diff-lines', this.payload(key));
    } catch {
      return; // no workspace / transient git failure — keep what's painted
    }
    if (this.disposed || seq !== this.diffSeq || key !== this.docKey) return;
    const model = this.editor.getModel();
    if (!model || model.isDisposed()) return;
    // Untracked / non-repo: show nothing (an all-green new file is just noise).
    if (!res.tracked) {
      this.gutter.clear();
      return;
    }
    const lineCount = model.getLineCount();
    const clamp = (n: number): number => Math.min(Math.max(1, n), lineCount);
    const decos: monaco.editor.IModelDeltaDecoration[] = [];
    for (const r of res.ranges) {
      decos.push({
        range: new monaco.Range(clamp(r.startLine), 1, clamp(r.endLine), 1),
        options: {
          linesDecorationsClassName:
            r.kind === 'added' ? 'marudesk-gutter-added' : 'marudesk-gutter-modified',
          stickiness:
            monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    }
    for (const after of res.deletedAfter) {
      // `after` is the boundary line the deletion sits below; 0 means content
      // was removed before the first line, so the triangle flips to line 1's top.
      const line = clamp(after === 0 ? 1 : after);
      decos.push({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          linesDecorationsClassName:
            after === 0 ? 'marudesk-gutter-deleted-top' : 'marudesk-gutter-deleted',
          stickiness:
            monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    }
    this.gutter.set(decos);
  }

  private async updateBlame(): Promise<void> {
    const key = this.docKey;
    if (!this.blameEnabled || !key || isUntitledDocKey(key)) {
      this.blame.clear();
      return;
    }
    const buf = useEditorStore.getState().files[key];
    // Suppress while the buffer is dirty: blame line numbers refer to the
    // saved file, so annotating mid-edit would both flicker and mislabel.
    if (!isTextFileBuf(buf) || isDirty(buf)) {
      this.blame.clear();
      return;
    }
    const saved = buf.saved ?? '';
    const cached = this.blameCache.get(key);
    let lines: GitBlameLine[] | null;
    if (cached && cached.saved === saved) {
      lines = cached.lines;
    } else {
      // A fetch for this exact key+content is already running — its completion
      // paints at the cursor position current THEN, so just let it finish.
      if (this.blamePending?.key === key && this.blamePending.saved === saved) {
        return;
      }
      this.blamePending = { key, saved };
      const seq = ++this.blameSeq;
      let res: GitBlameFile;
      try {
        res = await window.marudesk.invoke('git:blame-file', this.payload(key));
      } catch {
        this.blamePending = null;
        return;
      }
      this.blamePending = null;
      if (this.disposed || seq !== this.blameSeq || key !== this.docKey) return;
      lines = res.ok ? res.lines : null;
      // Insertion-ordered Map → dropping the first key evicts the oldest doc,
      // keeping the cache bounded across a long session of many files.
      if (this.blameCache.size >= 50 && !this.blameCache.has(key)) {
        const oldest = this.blameCache.keys().next().value;
        if (oldest !== undefined) this.blameCache.delete(oldest);
      }
      this.blameCache.set(key, { saved, lines });
      // The user may have typed during the await — re-check before painting.
      if (isDirty(useEditorStore.getState().files[key])) {
        this.blame.clear();
        return;
      }
    }
    if (!lines || !this.blameEnabled) {
      this.blame.clear();
      return;
    }
    const model = this.editor.getModel();
    const pos = this.editor.getPosition();
    if (!model || model.isDisposed() || !pos) {
      this.blame.clear();
      return;
    }
    const entry = lines.find((l) => l.line === pos.lineNumber);
    if (!entry) {
      this.blame.clear();
      return;
    }
    const col = model.getLineMaxColumn(pos.lineNumber);
    this.blame.set([
      {
        range: new monaco.Range(pos.lineNumber, col, pos.lineNumber, col),
        options: {
          after: {
            content: formatBlame(entry),
            inlineClassName: 'marudesk-inline-blame',
            cursorStops: monaco.editor.InjectedTextCursorStops.None,
          },
          stickiness:
            monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      },
    ]);
  }
}
