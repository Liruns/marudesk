/**
 * On-demand runner for the screenshot harness (`npm run screens`).
 *
 * screens.spec.ts is excluded from the green e2e gate (it has no assertions and
 * can never fail), so playwright.config.ts only includes it when RUN_SCREENS is
 * set. This wrapper sets that env var cross-platform (so it works on Windows
 * cmd/PowerShell as well as POSIX shells) and invokes Playwright on the spec.
 *
 * Output: marudesk/.screens/*.png
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

const child = spawn(
  'npx',
  ['playwright', 'test', 'e2e/screens.spec.ts'],
  {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, RUN_SCREENS: '1' },
  },
);

child.on('exit', (code) => process.exit(code ?? 1));
