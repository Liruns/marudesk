import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';

export default defineConfig({
  // Monaco is loaded lazily (React.lazy on the editor surface), so without this
  // Vite discovers `monaco-editor` only on first file-open and runs an on-the-fly
  // dep re-optimization + full reload. Under vite-plugin-electron that reload
  // races the electron child restart and crashes the dev server with
  // ERR_IPC_CHANNEL_CLOSED. Pre-bundling Monaco and its workers at cold start
  // keeps the optimized set stable so no mid-session re-optimization fires.
  optimizeDeps: {
    include: [
      'monaco-editor',
      'monaco-editor/esm/vs/editor/editor.worker',
      'monaco-editor/esm/vs/language/json/json.worker',
      'monaco-editor/esm/vs/language/css/css.worker',
      'monaco-editor/esm/vs/language/html/html.worker',
      'monaco-editor/esm/vs/language/typescript/ts.worker',
      // xterm is lazy-loaded with the terminal tab; pre-bundle it (and the fit
      // addon) so the first open doesn't trigger a mid-session dep re-optimize
      // + full reload — the same race Monaco hit.
      '@xterm/xterm',
      '@xterm/addon-fit',
    ],
  },
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            emptyOutDir: false,
            lib: {
              entry: 'electron/main.ts',
              formats: ['es'],
              fileName: () => 'main.mjs',
            },
            rollupOptions: {
              // node-pty is a native module — never bundle it; load from
              // node_modules at runtime (the integrated terminal in main).
              external: ['electron', 'node-pty'],
              output: {
                // Force a single-file main bundle (no code splitting). In lib
                // mode rolldown still splits a bundled dep's dynamic `import()`
                // (the AI SDK's lazy tokenizer) into hashed sibling chunks
                // (token-*.js). Under vite-plugin-electron's watch+reload,
                // Electron can restart against a main.mjs whose siblings aren't
                // flushed yet and die with a bogus parse error ("missing )
                // after argument list"). One file → no cross-chunk reload race.
                // (rolldown's replacement for the deprecated inlineDynamicImports.)
                codeSplitting: false,
                // The bundled AI SDK reaches for `require('node:path')` etc., but
                // the main bundle is ESM (.mjs) with no `require`. Polyfill it
                // via createRequire so those CJS-interop calls resolve (rolldown
                // CJS-in-ESM). Installed before the bundle body runs.
                banner:
                  "import { createRequire as __cr } from 'node:module';\nglobalThis.require ||= __cr(import.meta.url);",
              },
            },
          },
        },
      },
      {
        entry: 'electron/preload.ts',
        onstart({ reload }) {
          reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            emptyOutDir: false,
            lib: {
              entry: 'electron/preload.ts',
              formats: ['cjs'],
              fileName: () => 'preload.cjs',
            },
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
      {
        entry: 'electron/inspect-preload.ts',
        onstart({ reload }) {
          reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            emptyOutDir: false,
            lib: {
              entry: 'electron/inspect-preload.ts',
              formats: ['cjs'],
              fileName: () => 'inspect-preload.cjs',
            },
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
    ]),
  ],
});
