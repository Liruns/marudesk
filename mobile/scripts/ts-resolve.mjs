import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Tiny ESM resolve hook for the headless smoke test only. The app source uses
 * extensionless relative imports (TS `bundler` resolution, required by Vite);
 * Node's `--experimental-strip-types` runner needs explicit extensions. Rather
 * than add `.ts` to production imports, this appends `.ts` / `/index.ts` for an
 * otherwise-unresolvable relative specifier. Mirrors marudesk's harness-loader.
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
