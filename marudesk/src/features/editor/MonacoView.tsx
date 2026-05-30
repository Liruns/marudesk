import { useEffect, useRef } from 'react';
import {
  EDITOR_FONT_MONO,
  EDITOR_OPTIONS,
  getModel,
  monaco,
  monacoThemeFor,
} from './monaco-setup';
import { useEditorStore } from './store';
import { resolveTheme, subscribeAppearance } from '../settings/store';
import type { AppSettings } from '../../../shared/settings';

// Cursor/scroll position per file, so switching tabs (or away to a web tab and
// back) restores where you were.
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();

/**
 * A single Monaco editor instance, reused across files: changing `path` swaps
 * the underlying model rather than recreating the editor. Models live in the
 * monaco-setup registry, so edits and undo history survive tab switches.
 */
export function MonacoView({ path }: { path: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const pathRef = useRef(path);
  // Keep the latest path in a ref for the create-once effect's save command and
  // teardown. Writing a ref during render is disallowed, so sync it post-render.
  useEffect(() => {
    pathRef.current = path;
  }, [path]);

  // Create the editor once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const editor = monaco.editor.create(host, EDITOR_OPTIONS);
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void useEditorStore.getState().save(pathRef.current);
    });
    return () => {
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
      const fontFamily =
        s.appearance.editorFontFamily.trim() || EDITOR_FONT_MONO;
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
    const sub = model.onDidChangeContent(() => {
      useEditorStore.getState().setContent(path, model.getValue());
    });
    return () => {
      const ed = editorRef.current;
      if (ed) viewStates.set(path, ed.saveViewState());
      sub.dispose();
    };
  }, [path]);

  return <div ref={hostRef} className="flex-1 min-h-0 min-w-0" />;
}
