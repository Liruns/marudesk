import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Project agent-instruction loading (docs/agentic-chat-v4-design.md §B2). The
 * agent should obey a repo's own conventions, so before a turn we fold the
 * workspace's instruction file into the system prompt — the same idea as
 * opencode/Claude Code reading AGENTS.md / CLAUDE.md.
 *
 * Up-front + first-match-wins: AGENTS.md beats CLAUDE.md beats .claude/CLAUDE.md,
 * read from the workspace root only. Bounded and best-effort — a missing,
 * oversized, or unreadable file is simply skipped. (On-demand per-subdirectory
 * lazy injection + a claim set is the next step; see §B2.)
 */

const INSTRUCTION_CANDIDATES = ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md'];
const MAX_INSTRUCTION_BYTES = 32_000;

/**
 * Resolve the workspace's instruction file (first match) into a system-prompt
 * fragment, or '' when there is no workspace / no instruction file.
 */
export async function loadWorkspaceInstructions(
  ws: { root: string } | null,
): Promise<string> {
  if (!ws) return '';
  for (const name of INSTRUCTION_CANDIDATES) {
    try {
      const content = await fs.readFile(path.join(ws.root, name), 'utf8');
      const trimmed = content.slice(0, MAX_INSTRUCTION_BYTES).trim();
      if (trimmed) {
        return `The user's repository ships an instruction file (${name}). Treat it as authoritative project conventions and follow it:\n\n${trimmed}`;
      }
    } catch {
      // not present / unreadable — try the next candidate
    }
  }
  return '';
}
