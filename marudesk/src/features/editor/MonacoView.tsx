import { useEffect, useRef, type MutableRefObject } from 'react';
import {
  EDITOR_OPTIONS,
  getModel,
  monaco,
  monacoThemeFor,
} from './monaco-setup';
import { useEditorStore } from './store';
import type { EditorStatus } from './EditorView';
import { resolveTheme, subscribeAppearance } from '../settings/store';
import { fontStack } from '../../../shared/fonts';
import type { AppSettings } from '../../../shared/settings';

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
  const pathRef = useRef(path);
  const onStatusRef = useRef(onStatus);
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
    const editor = monaco.editor.create(host, EDITOR_OPTIONS);
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void useEditorStore.getState().save(pathRef.current);
    });
    // Report cursor position up for the status bar (language is reported on each
    // model bind below, where it's known).
    const cursorSub = editor.onDidChangeCursorPosition((e) => {
      onStatusRef.current?.({
        line: e.position.lineNumber,
        column: e.position.column,
        language: editor.getModel()?.getLanguageId() ?? 'plaintext',
      });
    });
    return () => {
      cursorSub.dispose();
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
    const initial = useEditorStore.getState().files[path]?.content ?? '';
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
    });
    return () => {
      const ed = editorRef.current;
      if (ed) viewStates.set(path, ed.saveViewState());
      sub.dispose();
    };
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
