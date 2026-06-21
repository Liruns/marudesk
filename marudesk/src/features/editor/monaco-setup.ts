import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import type { WorkspaceFileRef } from '../../../shared/workspace';
import { registerModelDisposer, useEditorStore } from './store';
import './editor-git.css';

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

/* ── TypeScript / JavaScript IntelliSense ─────────────────────────────────────
 * The ts.worker above ships the full TS language service, so open buffers get
 * real completions, hover, signature help, and go-to-definition — not just
 * syntax colors. The service only sees OPEN models (there's no project/disk
 * access from the worker), so:
 *   - compilerOptions are permissive (strict off, allowJs) — red squiggles on a
 *     perfectly buildable but untyped workspace would just be noise;
 *   - module-not-found diagnostics are suppressed (diagnosticCodesToIgnore):
 *     imports of files that aren't open / node_modules can't resolve here, and
 *     flagging every one of them would drown real errors. Project-accurate
 *     errors come from the diagnostics feature (the project's own tsc).
 * NodeJs module resolution is the closest the worker's options enum offers to
 * `bundler` (the enum exposes only Classic | NodeJs).
 *
 * monaco-editor ≥0.52 exposes this API as the top-level `monaco.typescript`
 * namespace (`monaco.languages.typescript` is a deprecated stub).
 */
const TS_COMPILER_OPTIONS: monaco.typescript.CompilerOptions = {
  target: monaco.typescript.ScriptTarget.ESNext,
  module: monaco.typescript.ModuleKind.ESNext,
  moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
  jsx: monaco.typescript.JsxEmit.ReactJSX,
  allowJs: true,
  checkJs: false,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  resolveJsonModule: true,
  strict: false,
  noImplicitAny: false,
  skipLibCheck: true,
};

/**
 * TS diagnostic codes that depend on resolving files the worker can't see:
 * 2307/2792 "Cannot find module …", 7016 "Could not find a declaration file…",
 * 2306 "… is not a module" (a barrel that resolves but isn't open), and
 * 6133-adjacent 1479/2614 import-shape complaints that follow a failed resolve.
 */
const TS_IGNORED_DIAGNOSTICS = [2307, 2792, 7016, 2306, 1479, 2614];

for (const defaults of [
  monaco.typescript.typescriptDefaults,
  monaco.typescript.javascriptDefaults,
]) {
  defaults.setCompilerOptions(TS_COMPILER_OPTIONS);
  defaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: true,
    diagnosticCodesToIgnore: TS_IGNORED_DIAGNOSTICS,
  });
  // Mirror EVERY open model into the worker (not just the focused one), so
  // completions and go-to-definition work ACROSS the open files.
  defaults.setEagerModelSync(true);
}

/**
 * Reverse of the model-URI construction in {@link getModel}: extract the doc
 * key (legacy rel path, or `workspaceId:rootId:path`) from a workspace model
 * URI; null for anything else (lib.d.ts etc.).
 */
export function docKeyFromUri(uri: monaco.Uri): string | null {
  if (uri.scheme !== 'inmemory' || uri.authority !== 'workspace') return null;
  const key = uri.path.replace(/^\//, '');
  return key.length > 0 ? key : null;
}

/**
 * Rebuild the editor store's open-file input from a doc key. Multi-root keys
 * are `workspaceId:rootId:path` (ids are `workspace-<uuid>`/`root-<uuid>`, so
 * they never contain ':'); a legacy key is the bare workspace-relative path
 * (':' is rejected by the path validator, so the formats can't collide).
 */
export function fileInputFromDocKey(key: string): string | WorkspaceFileRef {
  const first = key.indexOf(':');
  if (first < 0) return key;
  const second = key.indexOf(':', first + 1);
  if (second < 0) return key;
  return {
    workspaceId: key.slice(0, first),
    rootId: key.slice(first + 1, second),
    path: key.slice(second + 1),
  };
}

// Go-to-definition across models: standalone Monaco can't open a different
// model on its own, so route the target through the editor store's openFile
// flow — the target tab activates (or opens, reading the file from disk) and
// the editor reveals the definition's position.
monaco.editor.registerEditorOpener({
  openCodeEditor(
    _source: monaco.editor.ICodeEditor,
    resource: monaco.Uri,
    selectionOrPosition?: monaco.IRange | monaco.IPosition,
  ): boolean {
    const key = docKeyFromUri(resource);
    if (!key) return false;
    let line = 1;
    let col = 1;
    if (selectionOrPosition) {
      if ('startLineNumber' in selectionOrPosition) {
        line = selectionOrPosition.startLineNumber;
        col = selectionOrPosition.startColumn;
      } else {
        line = selectionOrPosition.lineNumber;
        col = selectionOrPosition.column;
      }
    }
    void useEditorStore.getState().openFileAt(fileInputFromDocKey(key), line, col);
    return true;
  },
});

export const MARUDESK_THEME = 'marudesk';

// Chrome colors track the design tokens; syntax hues reuse the sanctioned
// AI-timeline palette (peach/sage/blue/lavender) so code reads as native to the
// app rather than importing VSCode's default rainbow. Functional coloring, like
// the timeline itself — distinct from the single-accent UI rule.
monaco.editor.defineTheme(MARUDESK_THEME, {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'F4F3F0', background: '121211' },
    { token: 'comment', foreground: '7E7C75', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'C0A8DD' },
    { token: 'string', foreground: '9FC9A2' },
    { token: 'number', foreground: 'DFA88F' },
    { token: 'regexp', foreground: 'DFA88F' },
    { token: 'type', foreground: '9FBBE0' },
    { token: 'type.identifier', foreground: '9FBBE0' },
    { token: 'delimiter', foreground: 'B0AEA8' },
    { token: 'tag', foreground: '9FBBE0' },
    { token: 'attribute.name', foreground: 'C0A8DD' },
    { token: 'attribute.value', foreground: '9FC9A2' },
  ],
  colors: {
    'editor.background': '#121211',
    'editor.foreground': '#F4F3F0',
    'editorLineNumber.foreground': '#7E7C75',
    'editorLineNumber.activeForeground': '#B0AEA8',
    'editorCursor.foreground': '#C75A3B',
    'editor.selectionBackground': '#C75A3B3A',
    'editor.inactiveSelectionBackground': '#C75A3B24',
    'editor.lineHighlightBackground': '#FFFFFF08',
    'editorIndentGuide.background1': '#FFFFFF0F',
    'editorIndentGuide.activeBackground1': '#FFFFFF1F',
    'editorGutter.background': '#121211',
    'editorWhitespace.foreground': '#FFFFFF14',
    'editorWidget.background': '#1A1A18',
    'editorWidget.border': '#FFFFFF1A',
    'editorSuggestWidget.background': '#1A1A18',
    'editorSuggestWidget.selectedBackground': '#C75A3B3A',
    'input.background': '#222220',
    'focusBorder': '#C75A3B',
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
    { token: 'comment', foreground: '827F77', fontStyle: 'italic' },
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
    'editor.background': '#FAF9F6',
    'editor.foreground': '#1C1B18',
    'editorLineNumber.foreground': '#ABA8A0',
    'editorLineNumber.activeForeground': '#54524C',
    'editorCursor.foreground': '#C75A3B',
    'editor.selectionBackground': '#C75A3B2A',
    'editor.inactiveSelectionBackground': '#C75A3B18',
    'editor.lineHighlightBackground': '#0000000A',
    'editorWidget.background': '#F2F1EC',
    'editorWidget.border': '#0000001A',
    'editorSuggestWidget.background': '#F2F1EC',
    'editorSuggestWidget.selectedBackground': '#C75A3B2A',
    'input.background': '#FAF9F6',
    focusBorder: '#C75A3B',
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
