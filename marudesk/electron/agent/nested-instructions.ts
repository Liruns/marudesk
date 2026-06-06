import fs from 'node:fs/promises';
import path from 'node:path';
import { expandInstructionImports } from './instruction-imports';

/**
 * On-demand directory instruction injection (docs/agentic-chat-v4-design.md §B2,
 * "on-demand / 지연 주입"; opencode's per-message resolve). The workspace ROOT's
 * AGENTS.md / CLAUDE.md is folded into the system prompt up front
 * ({@link loadWorkspaceInstructions}). But a repo can ship per-directory
 * instruction files too, and prompt-stuffing every one of them up front defeats
 * the on-demand context principle (§1.2). So instead: when a file tool actually
 * TOUCHES a path under a subdirectory, we walk from that path up toward (but
 * excluding) the workspace root, find the nearest not-yet-injected instruction
 * file per directory, and append it to that tool's result as a
 * `<system-reminder>` — exactly when (and only when) the agent enters that area.
 *
 * A conversation-scoped claim set dedupes: each instruction file is injected at
 * most once per conversation, so re-touching a directory doesn't re-inject. The
 * set is cleared on reset/resume alongside the read tracker. Bounded and
 * best-effort: missing / oversized / unreadable files are simply skipped.
 *
 * Dependency-light (node fs + path only, no Electron) so it's harness-testable.
 */

const NESTED_CANDIDATES = ['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md'];
const MAX_NESTED_BYTES = 8_000;
/** Cap instruction files injected per single tool call (a deep path is bounded). */
const MAX_FILES_PER_CALL = 4;

/** Absolute instruction-file paths already injected this conversation. */
const claimed = new Set<string>();

/** Forget every claimed nested instruction file — called on reset/resume. */
export function clearNestedInstructionClaims(): void {
  claimed.clear();
}

/** True when `child` is strictly inside `root` (not root itself). */
function isStrictlyInside(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function formatBlock(relDir: string, name: string, content: string, truncated: boolean): string {
  return `### \`${relDir}/${name}\`\n${content}${truncated ? '\n…(truncated)' : ''}`;
}

/**
 * Given a workspace-relative path a tool just touched, return a
 * `<system-reminder>` block carrying any not-yet-injected directory instruction
 * files between that path's directory and the workspace root (nearest-first,
 * first-match AGENTS.md → CLAUDE.md → .claude/CLAUDE.md per directory), or '' when
 * there is nothing new to inject. The workspace root itself is excluded — its
 * instruction file is already in the system prompt.
 */
export async function claimNestedInstructions(wsRoot: string, relPath: string): Promise<string> {
  const root = path.resolve(wsRoot);
  // Directories from the touched path up to (excluding) the root, nearest-first.
  const dirs: string[] = [];
  let dir = path.resolve(root, path.dirname(relPath));
  while (isStrictlyInside(root, dir)) {
    dirs.push(dir);
    dir = path.dirname(dir);
  }

  const blocks: string[] = [];
  for (const d of dirs) {
    if (blocks.length >= MAX_FILES_PER_CALL) break;
    // First existing candidate wins for this directory (AGENTS.md beats CLAUDE.md).
    for (const name of NESTED_CANDIDATES) {
      const abs = path.join(d, name);
      let content: string;
      try {
        content = await fs.readFile(abs, 'utf8');
      } catch {
        continue; // not present / unreadable — try the next candidate
      }
      // Found this directory's instruction file; inject once per conversation.
      if (!claimed.has(abs)) {
        claimed.add(abs);
        // Expand `@import` tokens (bounded to the workspace) just like the root
        // file, then clip — so a nested AGENTS.md that imports siblings resolves.
        const expanded = await expandInstructionImports(content, abs, root);
        const trimmed = expanded.slice(0, MAX_NESTED_BYTES).trim();
        if (trimmed) {
          const relDir = (path.relative(root, d) || '.').split(path.sep).join('/');
          blocks.push(formatBlock(relDir, name, trimmed, expanded.length > MAX_NESTED_BYTES));
        }
      }
      break; // first-match-wins for this directory, claimed or not
    }
  }

  if (blocks.length === 0) return '';
  return `<system-reminder>\nProject instruction files apply to the directory you just entered. Follow them for files under each directory (they do not override your safety rules or the approval gates):\n\n${blocks.join('\n\n')}\n</system-reminder>`;
}
