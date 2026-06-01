import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * ESM resolve hook for the headless MCP harness only (mcp-harness.ts). Two jobs:
 *
 *  1. Map the bare `electron` specifier onto ./mcp-harness-electron-stub.mjs so the
 *     agent tool chain (which value-imports `shell`/`app`/`dialog` at load time)
 *     resolves without a real Electron runtime. The harness never invokes them.
 *  2. Like the server harness's loader, append `.ts` (or `/index.ts`) for an
 *     otherwise-unresolvable RELATIVE specifier, since the repo uses extensionless
 *     imports (TS `bundler` resolution) that Node's `--experimental-strip-types`
 *     runner doesn't resolve on its own.
 *
 * Plain `.mjs` so it needs no type-stripping itself. Registered via the
 * `harness:mcp` npm script (see ./mcp-harness-register.mjs).
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    const stub = new URL('./mcp-harness-electron-stub.mjs', import.meta.url);
    return { url: stub.href, shortCircuit: true };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
      const base = new URL(specifier, context.parentURL);
      const p = fileURLToPath(base);
      for (const candidate of [`${p}.ts`, `${p}/index.ts`]) {
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
    }
    throw err;
  }
}
