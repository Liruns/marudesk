import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * A tiny ESM resolve hook for the CLI bridge harness only. The repo's source
 * uses extensionless relative imports (TS `bundler` resolution); Node's
 * `--experimental-strip-types` runner requires explicit extensions. Rather than
 * pollute production files with `.ts` extensions, this hook appends `.ts` (or
 * `/index.ts`) for an otherwise-unresolvable relative specifier. Scope is narrow:
 * it only kicks in on a FAILED default resolve for a relative path. Plain `.mjs`
 * so it needs no type-stripping itself.
 *
 * Registered as a module-customization hook (see package.json `harness:server`):
 *   node --experimental-strip-types --import ./electron/cli-bridge/harness-register.mjs electron/cli-bridge/harness.ts
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
      const base = new URL(specifier, context.parentURL);
      const path = fileURLToPath(base);
      for (const candidate of [`${path}.ts`, `${path}/index.ts`]) {
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
    }
    throw err;
  }
}
