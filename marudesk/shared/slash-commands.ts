/**
 * Slash command registry (docs/agentic-chat-v4-design.md Track B — composer
 * affordances; claude-code `/init` `/review` `/compact`, codex `/diff` parity).
 *
 * Pure data + types so both the renderer composer and any future main-side
 * resolver share one source of truth. A command is either:
 *
 * - `action`: handled entirely in the renderer (open a panel, reset the chat,
 *   show an info card) — no model call.
 * - `prompt`: expands into a templated instruction that is sent to the agent as
 *   an ordinary turn. `expand(arg)` builds the final prompt from any trailing
 *   text the user typed after the command (e.g. `/explain the auth flow`).
 *
 * Keep this list small and high-signal; every entry shows up in the `/` menu.
 */

/** Renderer-resolved commands — each maps to a concrete composer action. */
export type SlashActionId = 'new' | 'diff' | 'context' | 'help' | 'model' | 'compact' | 'copy';

export type SlashActionCommand = {
  kind: 'action';
  /** Canonical name without the leading slash. */
  name: string;
  /** Extra names that resolve to the same command (shown only by `name`). */
  aliases?: string[];
  /** One-line description for the menu row. */
  description: string;
  /** Placeholder hint for an optional trailing argument, e.g. "what to keep". */
  argHint?: string;
  action: SlashActionId;
};

export type SlashPromptCommand = {
  kind: 'prompt';
  name: string;
  aliases?: string[];
  description: string;
  /** Placeholder hint for the trailing argument, e.g. "file or symbol". */
  argHint?: string;
  /** Build the instruction sent to the agent from the trailing text. */
  expand: (arg: string) => string;
};

export type SlashCommand = SlashActionCommand | SlashPromptCommand;

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    kind: 'prompt',
    name: 'init',
    description: 'Generate an AGENTS.md describing this project for agents',
    expand: () =>
      'Create or update an AGENTS.md at the repo root that lets an AI agent be ' +
      'productive here immediately. First investigate: read the README, package ' +
      'manifests, and config to learn the structure, the main directories and what ' +
      'they own, how to install/build/test/lint/run, and any conventions worth ' +
      'following (naming, formatting, commit/PR norms). If an AGENTS.md already ' +
      'exists, refine it rather than rewriting from scratch, and fold in any ' +
      'CLAUDE.md or .cursorrules content. Keep it concise, concrete, and command-' +
      'accurate — verify the commands exist in the manifest before listing them. ' +
      'Write the file when you have enough signal, then summarize what you put in it.',
  },
  {
    kind: 'prompt',
    name: 'review',
    aliases: ['r'],
    description: 'Review the current changes for bugs and risks',
    argHint: 'optional focus',
    expand: (arg) =>
      'Act as a careful senior reviewer of the uncommitted changes in this ' +
      'workspace. Start from the actual diff (git diff plus any untracked files), ' +
      'and read enough surrounding code to judge each change in context. Look for ' +
      'correctness bugs, broken edge cases, race conditions, error/' +
      'null handling gaps, security and data-loss risks, and anything that ' +
      'contradicts the project conventions. Report concrete findings grouped by ' +
      'severity (Critical / Major / Minor / Nit), each with the file:line and a ' +
      'specific fix; call out what looks correct too. If nothing is wrong, say so ' +
      'plainly. This is review only — do not edit files.' +
      (arg ? ` Pay special attention to: ${arg}.` : ''),
  },
  {
    kind: 'prompt',
    name: 'test',
    description: 'Run the project tests and fix any failures',
    argHint: 'optional path',
    expand: (arg) =>
      `Run the project's test suite${arg ? ` for ${arg}` : ''} and get it green. ` +
      'Discover the right test command from the project config rather than ' +
      'assuming. When a test fails, read the actual error and trace it to the ' +
      'root cause before changing anything — fix the underlying bug, not the ' +
      'assertion, and never weaken or skip a test to make it pass. Re-run after ' +
      'each fix to confirm, and keep going until the suite passes (or report ' +
      'precisely what remains and why). Summarize what failed and what you changed.',
  },
  {
    kind: 'prompt',
    name: 'explain',
    description: 'Explain a file, symbol, or part of the codebase',
    argHint: 'file or symbol',
    expand: (arg) =>
      arg
        ? `Explain ${arg}. Read the relevant files first, then walk through what it ` +
          'does, the role it plays in the wider codebase, how data and control flow ' +
          'through it, and any non-obvious behavior, edge cases, or gotchas. Ground ' +
          'the explanation in the real code with file:line references; do not edit ' +
          'anything.'
        : 'Give me a guided tour of this codebase. Read the key entry points and ' +
          'config first, then explain the overall architecture, how the main pieces ' +
          'fit together, the important directories, and where to start for common ' +
          'tasks. Ground it in real files with references; do not edit anything.',
  },
  {
    kind: 'prompt',
    name: 'commit',
    description: 'Stage changes and write a descriptive commit message',
    argHint: 'optional intent',
    expand: (arg) =>
      'Commit the current work. Review what changed (git status and git diff, ' +
      'including untracked files) and group it into one logical commit — flag it ' +
      'if the changes really should be split. Stage the relevant files (do not ' +
      'commit unrelated artifacts, secrets, or debug leftovers), then write a ' +
      'commit message that follows this repo\'s existing style: a concise summary ' +
      'line plus a body explaining the WHY, not just the what. Show me the message ' +
      'and run the commit; do not push.' +
      (arg ? ` Intent for this change: ${arg}.` : ''),
  },
  {
    kind: 'action',
    name: 'diff',
    description: 'Jump to the changes this conversation has applied',
    action: 'diff',
  },
  {
    kind: 'action',
    name: 'context',
    aliases: ['status'],
    description: 'Show the session config and what is in the context window',
    action: 'context',
  },
  {
    kind: 'action',
    name: 'copy',
    description: 'Copy the whole conversation as markdown',
    action: 'copy',
  },
  {
    kind: 'action',
    name: 'compact',
    description: 'Summarize earlier turns to free context (history stays visible)',
    argHint: 'optional: what to keep',
    action: 'compact',
  },
  {
    kind: 'action',
    name: 'model',
    description: 'Switch the provider or model',
    action: 'model',
  },
  {
    kind: 'action',
    name: 'new',
    aliases: ['clear'],
    description: 'Start a new conversation',
    action: 'new',
  },
  {
    kind: 'action',
    name: 'help',
    description: 'List the available slash commands',
    action: 'help',
  },
];

/** True when `text` is the start of a slash-command invocation (leading `/`). */
export function isSlashInvocation(text: string): boolean {
  return /^\/[^\s]*$/.test(text) || /^\/[a-zA-Z][\w-]*\s/.test(text);
}

/** The token typed right after the leading slash, used to filter the menu. */
export function slashQuery(text: string): string | null {
  const m = /^\/([a-zA-Z][\w-]*)?$/.exec(text);
  return m ? (m[1] ?? '') : null;
}

function matchesName(cmd: SlashCommand, token: string): boolean {
  if (cmd.name === token) return true;
  return (cmd.aliases ?? []).includes(token);
}

/** Resolve a fully-typed command line (`/review auth`) to its command + arg. */
export function resolveSlash(
  text: string,
): { command: SlashCommand; arg: string } | null {
  const m = /^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const token = m[1].toLowerCase();
  const arg = (m[2] ?? '').trim();
  const command = SLASH_COMMANDS.find((c) => matchesName(c, token));
  return command ? { command, arg } : null;
}

/** Filter commands by the current query token (prefix match on name/alias). */
export function filterSlash(query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (q === '') return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((c) =>
    [c.name, ...(c.aliases ?? [])].some((n) => n.startsWith(q)),
  );
}
