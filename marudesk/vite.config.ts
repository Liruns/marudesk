import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';

// vite-plugin-electron stashes the spawned Electron child on `process` so the
// reload hook can reach it. Type that access locally (an optional extra prop is
// assignable from the base `process`, so no cast) rather than augmenting the
// global NodeJS.Process namespace.
type ProcessWithElectronApp = NodeJS.Process & {
  readonly electronApp?: ChildProcess;
};

// Absolute path to tslib's ESM build — see the resolve.alias note on the main
// process build below.
const tslibEsm = fileURLToPath(
  new URL('./node_modules/tslib/tslib.es6.mjs', import.meta.url),
);

const electronAppsWithClosedIpcHandler = new WeakSet<ChildProcess>();

function hasErrorCode(error: Error): error is Error & { readonly code: string } {
  return 'code' in error && typeof error.code === 'string';
}

function isClosedElectronIpcError(error: Error): boolean {
  return hasErrorCode(error) && ['EPIPE', 'ERR_IPC_CHANNEL_CLOSED'].includes(error.code);
}

function installClosedIpcErrorHandler(electronApp: ChildProcess | undefined): void {
  if (!electronApp || electronAppsWithClosedIpcHandler.has(electronApp)) return;

  electronAppsWithClosedIpcHandler.add(electronApp);
  electronApp.on('error', (error: Error) => {
    if (isClosedElectronIpcError(error)) return;
    throw error;
  });
}

function reloadPreload(args: { readonly reload: () => void }): void {
  const proc: ProcessWithElectronApp = process;
  installClosedIpcErrorHandler(proc.electronApp);
  args.reload();
}

export const __test = {
  installClosedIpcErrorHandler,
  isClosedElectronIpcError,
} as const;

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
          // asn1js (pulled in by the OAuth/secure-pairing crypto path) is compiled
          // to CommonJS with `importHelpers`, so it does `require('tslib')`. In the
          // single-file ESM main bundle, rolldown resolves that require to tslib's
          // UMD build (`tslib.js`) whose CJS→ESM interop yields an `undefined`
          // default — the main process then crashes at startup destructuring
          // `__extends` off it. Pin tslib to its real ESM build so the helpers are
          // genuine named exports. Scoped to the main build; renderer/preload
          // resolve tslib normally.
          resolve: {
            alias: [{ find: /^tslib$/, replacement: tslibEsm }],
          },
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
              // node_modules at runtime (the integrated terminal, in main). The
              // SQLite session store now uses Node's built-in node:sqlite, which
              // is externalized as a node: builtin automatically. ssh2 (remote
              // SSH workspace roots) is CommonJS with optional native bindings —
              // keep it external so its dynamic requires resolve at runtime.
              // electron-updater (Windows auto-update, electron/updater.ts) is the
              // same category as ssh2 — CommonJS with lazy/dynamic requires
              // (builder-util-runtime, js-yaml) that don't survive single-file
              // bundling — so keep it external too. electron-builder ships it in the
              // packaged node_modules automatically as a production dependency.
              external: ['electron', 'node-pty', 'ssh2', 'electron-updater'],
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
        onstart(args) {
          reloadPreload(args);
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
        onstart(args) {
          reloadPreload(args);
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
      {
        // The isolated plugin worker (docs/plugin-runtime-design.md §3). Built as
        // its own standalone ESM file so the main process can `utilityProcess.fork`
        // it at runtime. It must stay Electron-free; plugin code is loaded by the
        // worker via require() at runtime and is never bundled here.
        entry: 'electron/plugins/worker.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            emptyOutDir: false,
            lib: {
              entry: 'electron/plugins/worker.ts',
              formats: ['es'],
              fileName: () => 'plugin-worker.mjs',
            },
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
      {
        // The terminal chat client (docs/chat-cli-tui-design.md). A standalone,
        // Electron-free ESM file (shared/* inlined, node: builtins only) that the
        // `agent-cli` terminal profile spawns with ELECTRON_RUN_AS_NODE — and that
        // `npm run chat` mirrors from source. Rebuilding it must NOT restart the
        // dev Electron app (it's spawned per terminal), hence the no-op onstart.
        entry: 'cli/main.ts',
        onstart() {},
        vite: {
          build: {
            outDir: 'dist-electron',
            emptyOutDir: false,
            lib: {
              entry: 'cli/main.ts',
              formats: ['es'],
              fileName: () => 'chat-cli.mjs',
            },
          },
        },
      },
    ]),
  ],
});
