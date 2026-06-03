import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { registerModelDisposer } from './store';

/**
 * One-time Monaco bootstrap: wire web workers, define the app theme, and own
 * the per-file model registry. Importing this module is what pulls Monaco in,
 * so only the editor surface depends on it.
 *
 * Workers are bundled locally (Vite `?worker`) rather than fetched from a CDN —
 * the renderer CSP forbids cross-origin scripts, and an offline desktop app
 * can't reach a CDN anyway.
 */

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
    __marudeskMonacoCancelGuard?: boolean;
  }
}

window.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

// Monaco throws an internal "Canceled" error when an editor (and its in-flight
// async contributions — occurrence/word highlighting, suggestions, etc.) is
// disposed mid-work. That's expected teardown, but the rejected promise has no
// catch inside Monaco, so it leaks as a noisy "Uncaught (in promise) Canceled":
// most visibly under React StrictMode's mount→unmount→remount in dev, and on
// fast editor-tab / split-mode switches in prod. Swallow ONLY that exact benign
// cancellation (by Monaco's `name`/`message === 'Canceled'` signature); every
// other rejection propagates untouched. Installed once, guarded by a window flag
// so HMR re-imports don't stack duplicate listeners.
if (!window.__marudeskMonacoCancelGuard) {
  window.__marudeskMonacoCancelGuard = true;
  window.addEventListener('unhandledrejection', (e) => {
    const r: unknown = e.reason;
    const canceled =
      r === 'Canceled' ||
      (typeof r === 'object' &&
        r !== null &&
        ((r as { name?: unknown }).name === 'Canceled' ||
          (r as { message?: unknown }).message === 'Canceled'));
    if (canceled) e.preventDefault();
  });
}

export const MARUDESK_THEME = 'marudesk';

// Chrome colors track the design tokens; syntax hues reuse the sanctioned
// AI-timeline palette (peach/sage/blue/lavender) so code reads as native to the
// app rather than importing VSCode's default rainbow. Functional coloring, like
// the timeline itself — distinct from the single-accent UI rule.
monaco.editor.defineTheme(MARUDESK_THEME, {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'F7F8F8', background: '08090A' },
    { token: 'comment', foreground: '62666D', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'C0A8DD' },
    { token: 'string', foreground: '9FC9A2' },
    { token: 'number', foreground: 'DFA88F' },
    { token: 'regexp', foreground: 'DFA88F' },
    { token: 'type', foreground: '9FBBE0' },
    { token: 'type.identifier', foreground: '9FBBE0' },
    { token: 'delimiter', foreground: '8A8F98' },
    { token: 'tag', foreground: '9FBBE0' },
    { token: 'attribute.name', foreground: 'C0A8DD' },
    { token: 'attribute.value', foreground: '9FC9A2' },
  ],
  colors: {
    'editor.background': '#08090A',
    'editor.foreground': '#F7F8F8',
    'editorLineNumber.foreground': '#62666D',
    'editorLineNumber.activeForeground': '#8A8F98',
    'editorCursor.foreground': '#5E6AD2',
    'editor.selectionBackground': '#5E6AD23A',
    'editor.inactiveSelectionBackground': '#5E6AD224',
    'editor.lineHighlightBackground': '#FFFFFF08',
    'editorIndentGuide.background1': '#FFFFFF0F',
    'editorIndentGuide.activeBackground1': '#FFFFFF1F',
    'editorGutter.background': '#08090A',
    'editorWhitespace.foreground': '#FFFFFF14',
    'editorWidget.background': '#1A1B1F',
    'editorWidget.border': '#FFFFFF1A',
    'editorSuggestWidget.background': '#1A1B1F',
    'editorSuggestWidget.selectedBackground': '#5E6AD23A',
    'input.background': '#23252B',
    'focusBorder': '#5E6AD2',
    'scrollbarSlider.background': '#FFFFFF14',
    'scrollbarSlider.hoverBackground': '#FFFFFF24',
    'scrollbarSlider.activeBackground': '#FFFFFF2E',
  },
});

// Light counterpart, used when the resolved app theme is light. Base 'vs' gives
// sensible light syntax defaults; chrome colors are overridden to the tokens.
export const MARUDESK_THEME_LIGHT = 'marudesk-light';

monaco.editor.defineTheme(MARUDESK_THEME_LIGHT, {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '80858E', fontStyle: 'italic' },
    { token: 'keyword', foreground: '7A3EAF' },
    { token: 'string', foreground: '2F7D4F' },
    { token: 'number', foreground: 'B0541F' },
    { token: 'regexp', foreground: 'B0541F' },
    { token: 'type', foreground: '2F5FA8' },
    { token: 'type.identifier', foreground: '2F5FA8' },
    { token: 'attribute.name', foreground: '7A3EAF' },
    { token: 'attribute.value', foreground: '2F7D4F' },
  ],
  colors: {
    'editor.background': '#FFFFFF',
    'editor.foreground': '#1C1D21',
    'editorLineNumber.foreground': '#A9ADB5',
    'editorLineNumber.activeForeground': '#585C64',
    'editorCursor.foreground': '#5E6AD2',
    'editor.selectionBackground': '#5E6AD22A',
    'editor.inactiveSelectionBackground': '#5E6AD218',
    'editor.lineHighlightBackground': '#0000000A',
    'editorWidget.background': '#F7F8FA',
    'editorWidget.border': '#0000001A',
    'editorSuggestWidget.background': '#F7F8FA',
    'editorSuggestWidget.selectedBackground': '#5E6AD22A',
    'input.background': '#FFFFFF',
    focusBorder: '#5E6AD2',
  },
});

/** Pick the Monaco theme name for a resolved (dark | light) app theme. */
export function monacoThemeFor(resolved: 'dark' | 'light'): string {
  return resolved === 'light' ? MARUDESK_THEME_LIGHT : MARUDESK_THEME;
}

export const EDITOR_FONT_MONO =
  "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

export const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions =
  {
    theme: MARUDESK_THEME,
    automaticLayout: true,
    fontFamily: EDITOR_FONT_MONO,
    fontSize: 13,
    lineHeight: 20,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    tabSize: 2,
    padding: { top: 10, bottom: 10 },
    fixedOverflowWidgets: true,
    scrollbar: { useShadows: false },
    // Readability touches: colorize matching brackets, keep the enclosing
    // scope pinned at the top while scrolling, and show bracket-pair guides.
    bracketPairColorization: { enabled: true },
    stickyScroll: { enabled: true },
    guides: { bracketPairs: 'active' },
  };

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  vue: 'html',
  svelte: 'html',
  md: 'markdown',
  mdx: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  sql: 'sql',
  xml: 'xml',
  svg: 'xml',
  graphql: 'graphql',
  gql: 'graphql',
};

export function languageForPath(filePath: string): string {
  const name = filePath.split('/').pop() ?? filePath;
  if (name.toLowerCase() === 'dockerfile') return 'dockerfile';
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  return LANGUAGE_BY_EXT[ext] ?? 'plaintext';
}

const models = new Map<string, monaco.editor.ITextModel>();

/** Get or create the Monaco model for a workspace-relative path. */
export function getModel(
  filePath: string,
  initialContent: string,
): monaco.editor.ITextModel {
  const existing = models.get(filePath);
  if (existing && !existing.isDisposed()) return existing;
  const uri = monaco.Uri.from({
    scheme: 'inmemory',
    authority: 'workspace',
    path: '/' + filePath,
  });
  const model = monaco.editor.createModel(
    initialContent,
    languageForPath(filePath),
    uri,
  );
  models.set(filePath, model);
  return model;
}

/** Dispose the cached model for a path (called when its tab closes). */
export function disposeModel(filePath: string): void {
  const model = models.get(filePath);
  if (model) {
    model.dispose();
    models.delete(filePath);
  }
}

// Hand the disposer to the store now that Monaco is loaded, so tab-close pruning
// can dispose models synchronously.
registerModelDisposer(disposeModel);

export { monaco };
