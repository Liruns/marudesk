import { spawn } from 'node:child_process';
import { scrubText } from '../../../shared/scrub';
import { inheritSafeEnv } from '../../proc-env';
import type { Executor, ToolResult } from './types';

/**
 * `run_command` — let the agent run the OPEN WORKSPACE's own checks (type-check,
 * lint, build, tests) and read the result. This is Tier 0 of the language-support
 * ladder (docs/workspace-language-support-design.md): rather than marudesk
 * embedding a language server per ecosystem, the agent invokes the project's real
 * tooling, which already encodes the correct config — so the diagnostics it sees
 * are the trustworthy ones (no isolated-worker "cannot find module" noise).
 *
 * Safety: a command runs arbitrary code on the user's machine, so the tool is
 * `gated` (per-call approval, see GATED_TOOLS) and `write` (refused in read-only /
 * plan mode). Secret-shaped env vars are stripped before spawning — same
 * inherit-minus-secrets posture as the integrated terminal (electron/terminal.ts).
 * Output is bounded and the run is time-boxed, so a runaway or interactive command
 * can't wedge the turn; the turn's AbortSignal kills the child.
 */

/** Cap captured output so a chatty command can't blow up the model context. */
const MAX_OUTPUT = 60_000;
/** Default run cap; commands are meant to be finite checks/builds, not servers. */
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;

function clampTimeout(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(raw)));
}

export const runCommand: Executor = (input, ctx): Promise<ToolResult> => {
  const command = typeof input.command === 'string' ? input.command.trim() : '';
  if (!command) {
    return Promise.resolve({
      summary: 'run_command',
      text: 'run_command requires a non-empty "command".',
      isError: true,
    });
  }
  if (!ctx.ws) {
    return Promise.resolve({
      summary: 'run_command',
      text: 'no workspace is open — run_command uses the workspace root as its working directory.',
      isError: true,
    });
  }

  const cwd = ctx.ws.root;
  const timeoutMs = clampTimeout(input.timeoutMs);
  const label = `run ${command}`.slice(0, 80);

  return new Promise<ToolResult>((resolve) => {
    // `shell: true` runs the command string through the platform shell, so a
    // checker like `npm run typecheck` works as written (incl. Windows `.cmd`
    // shims). The user approved this exact string via the gated approval card,
    // and it targets their own machine — same trust model as the integrated
    // terminal — so shell interpretation is intended, not an injection vector.
    const child = spawn(command, { cwd, env: inheritSafeEnv(), shell: true });

    let output = '';
    let truncated = false;
    const append = (chunk: Buffer): void => {
      if (truncated) return;
      output += chunk.toString('utf8');
      if (output.length > MAX_OUTPUT) {
        output = output.slice(0, MAX_OUTPUT);
        truncated = true;
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const onAbort = (): void => {
      child.kill();
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = (): void => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
    };

    child.on('error', (err) => {
      cleanup();
      resolve({
        summary: label,
        text: `$ ${command}\nfailed to start — ${scrubText(err.message)}`,
        isError: true,
      });
    });

    child.on('close', (code, signal) => {
      cleanup();
      const status = timedOut
        ? `timed out after ${timeoutMs}ms`
        : ctx.signal.aborted
          ? 'aborted'
          : signal
            ? `killed by ${signal}`
            : `exit code ${code}`;
      const body = scrubText(output).trim() || '(no output)';
      const note = truncated ? `\n…(output truncated to ${MAX_OUTPUT} chars)` : '';
      resolve({
        summary: label,
        text: `$ ${command}\n(${status})\n\n${body}${note}`,
        isError: timedOut || code !== 0,
      });
    });
  });
};
