import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Runtime/environment context block (Claude Code + Codex parity). Both inject
 * the machine + repo facts the model would otherwise guess at — today's date,
 * the platform/OS, the workspace root, and the git branch/dirty state. marudesk's
 * base system prompt is static, so we build this fresh each turn and fold it in
 * near the top as trusted grounding (it is OUR data, not repo-controlled text).
 *
 * Best-effort and bounded: git facts are skipped when there's no workspace, the
 * directory isn't a repo, or git isn't installed / times out.
 */

const execAsync = promisify(exec);
const GIT_TIMEOUT_MS = 2_000;

function platformLabel(): string {
  switch (process.platform) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    default:
      return process.platform;
  }
}

/** Branch + dirty count + latest commit subject, or null when not a git repo. */
async function gitFacts(root: string): Promise<string | null> {
  try {
    const opts = { cwd: root, timeout: GIT_TIMEOUT_MS, windowsHide: true } as const;
    const inside = (await execAsync('git rev-parse --is-inside-work-tree', opts)).stdout.trim();
    if (inside !== 'true') return null;
    const [branchRes, statusRes, logRes] = await Promise.all([
      execAsync('git rev-parse --abbrev-ref HEAD', opts).catch(() => null),
      execAsync('git status --porcelain', opts).catch(() => null),
      execAsync('git log -1 --pretty=%h\\ %s', opts).catch(() => null),
    ]);
    const branch = branchRes?.stdout.trim() || 'unknown';
    const dirtyCount = statusRes ? statusRes.stdout.split('\n').filter((l) => l.trim()).length : 0;
    const head = logRes?.stdout.trim().slice(0, 120);
    const dirty = dirtyCount === 0 ? 'clean' : `${dirtyCount} uncommitted change${dirtyCount === 1 ? '' : 's'}`;
    return `branch ${branch}, ${dirty}${head ? `, HEAD ${head}` : ''}`;
  } catch {
    return null; // git missing / timed out / not a repo
  }
}

/**
 * The `<environment>` block for this turn, or '' when there's nothing useful to
 * say (there's always at least a date, so this returns non-empty in practice).
 */
export async function buildEnvironmentContext(ws: { root: string; name?: string } | null): Promise<string> {
  const lines: string[] = [
    `Today's date: ${new Date().toISOString().slice(0, 10)}`,
    `Platform: ${platformLabel()} (${os.release()})`,
  ];
  const shell = process.env.SHELL || process.env.ComSpec;
  if (shell) lines.push(`Shell: ${shell}`);
  if (ws) {
    lines.push(`Workspace root: ${ws.root}`);
    const git = await gitFacts(ws.root);
    lines.push(`Git: ${git ?? 'not a git repository'}`);
  } else {
    lines.push('Workspace: none open (file tools are unavailable this turn).');
  }
  return `<environment>\n${lines.join('\n')}\n</environment>`;
}
