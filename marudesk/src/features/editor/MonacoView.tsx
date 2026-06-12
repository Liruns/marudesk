import { useEffect, useRef, type MutableRefObject } from 'react';
import {
  EDITOR_OPTIONS,
  getModel,
  monaco,
  monacoThemeFor,
} from './monaco-setup';
import { useEditorStore, type RevealRequest } from './store';
import { GitEditorDecorations } from './git-decorations';
import { ConflictEditorAid } from './conflict-decorations';
import { ensureDiagnosticMarkers } from '../diagnostics/markers';
import type { EditorStatus } from './EditorView';
import {
  resolveTheme,
  subscribeAppearance,
  useSettingsStore,
} from '../settings/store';
import { useGitStore } from '../git/store';
import { isTextFileBuf } from './buffer';
import { fontStack } from '../../../shared/fonts';
import type { AppSettings } from '../../../shared/settings';

/**
 * Ctrl/Cmd+S: optionally format, then save through the store. Formatting runs
 * only when the setting is on AND Monaco has a format provider for the model's
 * language (TS/JS/JSON/CSS/HTML built-ins); a missing formatter or a formatting
 * failure never blocks the save. The format edits flow through the normal
 * onDidChangeContent → setContent path before save() reads the buffer, so
 * dirty tracking stays consistent.
 */
async function formatAndSave(
  editor: monaco.editor.IStandaloneCodeEditor,
  path: string,
): Promise<void> {
  if (useSettingsStore.getState().settings.editor.formatOnSave) {
    try {
      const action = editor.getAction('editor.action.formatDocument');
      if (action && action.isSupported()) await action.run();
    } catch {
      // No formatter for this language / formatter error — save unformatted.
    }
  }
  await useEditorStore.getState().save(path);
}

// Cursor/scroll position per file, so switching tabs (or away to a web tab and
// back) restores where you were.
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();

/**
 * A single Monaco editor instance, reused across files: changing `path` swaps
 * the underlying model rather than recreating the editor. Models live in the
 * monaco-setup registry, so edits and undo history survive tab switches.
 */
export function MonacoView({
  path,
  wordWrap = false,
  onStatus,
  scrollRatio,
  scrollApplyingRef,
}: {
  path: string;
  /** Word-wrap toggle, owned by the status bar in EditorView. */
  wordWrap?: boolean;
  /** Report cursor + language up for the status bar. */
  onStatus?: (status: EditorStatus) => void;
  /** Target scroll as a 0..1 fraction, driven by the preview in split mode. */
  scrollRatio?: number;
  /** Set true by us right before a programmatic scroll, so EditorView's scroll
   * listener can recognise the echo and not bounce it back to the preview. */
  scrollApplyingRef?: MutableRefObject<boolean>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const gitDecorationsRef = useRef<GitEditorDecorations | null>(null);
  const conflictAidRef = useRef<ConflictEditorAid | null>(null);
  const pathRef = useRef(path);
  const onStatusRef = useRef(onStatus);
  // The last reveal nonce we acted on, so a model re-bind (tab switch) doesn't
  // re-jump to a stale match position.
  const revealNonceRef = useRef(0);
  // Keep the latest path + status callback in refs for the create-once effect's
  // listeners. Writing a ref during render is disallowed, so sync post-render.
  useEffect(() => {
    pathRef.current = path;
    onStatusRef.current = onStatus;
  }, [path, onStatus]);

  // Create the editor once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Project checker diagnostics onto the editor as markers (idempotent).
    ensureDiagnosticMarkers();
    const editor = monaco.editor.create(host, EDITOR_OPTIONS);
    editorRef.current = editor;
    // Git diff gutter + inline blame, driven by the hooks below (model bind,
    // cursor/content changes, saves, git-store refreshes, the blame setting).
    const gitDecorations = new GitEditorDecorations(editor);
    gitDecorationsRef.current = gitDecorations;
    // Merge-conflict aid: section highlights + accept-current/incoming/both
    // codelenses whenever the buffer contains conflict markers.
    const conflictAid = new ConflictEditorAid(editor);
    conflictAidRef.current = conflictAid;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void formatAndSave(editor, pathRef.current);
    });
    // Report cursor position up for the status bar (language is reported on each
    // model bind below, where it's known).
    const cursorSub = editor.onDidChangeCursorPosition((e) => {
      onStatusRef.current?.({
        line: e.position.lineNumber,
        column: e.position.column,
        language: editor.getModel()?.getLanguageId() ?? 'plaintext',
      });
      gitDecorations.onCursorChanged();
    });
    // Re-fetch the gutter/blame whenever Source Control refreshes its status —
    // a commit/stage/discard/branch switch changes what "vs HEAD" means.
    let lastGitStatus = useGitStore.getState().status;
    const unsubGit = useGitStore.subscribe((s) => {
      if (s.status === lastGitStatus) return;
      lastGitStatus = s.status;
      gitDecorations.onGitStateChanged();
    });
    // Live "Inline blame" setting.
    gitDecorations.setBlameEnabled(
      useSettingsStore.getState().settings.editor.inlineBlame,
    );
    const unsubSettings = useSettingsStore.subscribe((s) => {
      gitDecorations.setBlameEnabled(s.settings.editor.inlineBlame);
    });
    return () => {
      cursorSub.dispose();
      unsubGit();
      unsubSettings();
      conflictAid.dispose();
      conflictAidRef.current = null;
      gitDecorations.dispose();
      gitDecorationsRef.current = null;
      viewStates.set(pathRef.current, editor.saveViewState());
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  // Apply editor font + theme from settings and keep them live. Runs after the
  // create effect above, so editorRef is set. setTheme is global to Monaco —
  // fine here, there's a single editor instance.
  useEffect(() => {
    // Only these three fields matter; dirty-check so an unrelated settings
    // change (zoom, the loaded flag) doesn't trigger a global Monaco re-theme.
    let lastKey = '';
    const apply = (s: AppSettings) => {
      // The create-editor effect above runs first (same-component effects fire
      // in declaration order), so editorRef is set by subscribeAppearance's
      // immediate call — the guard is just defensive.
      const ed = editorRef.current;
      if (!ed) return;
      const fontFamily = fontStack(s.appearance.editorFontFamily, 'mono');
      const fontSize = s.appearance.editorFontSize;
      const theme = monacoThemeFor(resolveTheme(s.appearance.theme));
      const key = `${fontFamily}|${fontSize}|${theme}`;
      if (key === lastKey) return;
      lastKey = key;
      ed.updateOptions({ fontFamily, fontSize });
      monaco.editor.setTheme(theme);
    };
    return subscribeAppearance(apply);
  }, []);

  // Bind the model for the active path; keep the store mirror in sync.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const buf = useEditorStore.getState().files[path];
    const initial =
      buf?.status === 'ready' && buf.kind === 'text' ? buf.content : '';
    const model = getModel(path, initial);
    editor.setModel(model);
    const vs = viewStates.get(path);
    if (vs) editor.restoreViewState(vs);
    editor.focus();
    // Seed the status bar for the newly-bound file (cursor + its language).
    const pos = editor.getPosition();
    onStatusRef.current?.({
      line: pos?.lineNumber ?? 1,
      column: pos?.column ?? 1,
      language: model.getLanguageId(),
    });
    const sub = model.onDidChangeContent(() => {
      useEditorStore.getState().setContent(path, model.getValue());
      gitDecorationsRef.current?.onContentChanged();
      conflictAidRef.current?.refreshSoon();
    });
    // Bind the git decorations to this document, and re-fetch after each save
    // (the buffer's `saved` snapshot advancing is the save-completed signal).
    gitDecorationsRef.current?.setDocKey(path);
    conflictAidRef.current?.refresh();
    let lastSaved = (() => {
      const buf = useEditorStore.getState().files[path];
      return isTextFileBuf(buf) ? buf.saved : undefined;
    })();
    const unsubSaved = useEditorStore.subscribe((s) => {
      const buf = s.files[path];
      if (!isTextFileBuf(buf) || buf.saved === lastSaved) return;
      lastSaved = buf.saved;
      gitDecorationsRef.current?.onSaved();
    });
    return () => {
      const ed = editorRef.current;
      if (ed) viewStates.set(path, ed.saveViewState());
      sub.dispose();
      unsubSaved();
    };
  }, [path]);

  // Reveal a pending search-match position (from openFileAt). Applied both when
  // a new request arrives for the open file and after the model binds for a file
  // that was just opened; the nonce guard reveals once per request so a later
  // tab switch (which re-binds the model) doesn't re-jump.
  useEffect(() => {
    const applyReveal = (req: RevealRequest | null): void => {
      if (!req || req.key !== pathRef.current) return;
      if (req.nonce === revealNonceRef.current) return;
      const ed = editorRef.current;
      if (!ed) return;
      revealNonceRef.current = req.nonce;
      const lineCount = ed.getModel()?.getLineCount() ?? 1;
      const line = Math.min(Math.max(1, req.line), lineCount);
      ed.revealLineInCenter(line);
      ed.setPosition({ lineNumber: line, column: Math.max(1, req.col) });
      ed.focus();
    };
    applyReveal(useEditorStore.getState().revealRequest);
    return useEditorStore.subscribe((s) => applyReveal(s.revealRequest));
  }, [path]);

  // Word wrap is a live toggle from the status bar.
  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: wordWrap ? 'on' : 'off' });
  }, [wordWrap]);

  // Apply a preview-driven scroll fraction (split mode). Flag the echo first so
  // EditorView's scroll listener doesn't bounce it back to the preview.
  useEffect(() => {
    const ed = editorRef.current;
    if (ed === null || scrollRatio === undefined) return;
    const max = ed.getScrollHeight() - ed.getLayoutInfo().height;
    if (max <= 0) return;
    if (scrollApplyingRef) scrollApplyingRef.current = true;
    ed.setScrollTop(scrollRatio * max);
  }, [scrollRatio, scrollApplyingRef]);

  return <div ref={hostRef} className="flex-1 min-h-0 min-w-0" />;
}
