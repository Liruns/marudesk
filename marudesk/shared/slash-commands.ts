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
      'Analyze this workspace (structure, key directories, build/test commands, ' +
      'conventions) and create or update an AGENTS.md at the repo root that an AI ' +
      'agent could read to work here effectively. Keep it concise and concrete. ' +
      'Write the file when you have enough signal.',
  },
  {
    kind: 'prompt',
    name: 'review',
    aliases: ['r'],
    description: 'Review the current changes for bugs and risks',
    argHint: 'optional focus',
    expand: (arg) =>
      'Review the current uncommitted changes in this workspace for correctness ' +
      'bugs, edge cases, and risky patterns. Read the diff first, then report ' +
      'concrete findings grouped by severity. Do not edit files.' +
      (arg ? ` Focus on: ${arg}.` : ''),
  },
  {
    kind: 'prompt',
    name: 'test',
    description: 'Run the project tests and fix any failures',
    argHint: 'optional path',
    expand: (arg) =>
      `Run the project's test suite${arg ? ` for ${arg}` : ''}, read any failures, ` +
      'find the root cause, and fix the code so the tests pass. Re-run to confirm.',
  },
  {
    kind: 'prompt',
    name: 'explain',
    description: 'Explain a file, symbol, or part of the codebase',
    argHint: 'file or symbol',
    expand: (arg) =>
      arg
        ? `Explain ${arg}: what it does, how it fits into the codebase, and any ` +
          'non-obvious behavior. Read the relevant files first.'
        : 'Explain how this codebase is structured and how the main pieces fit ' +
          'together. Read the key files first.',
  },
  {
    kind: 'prompt',
    name: 'commit',
    description: 'Stage changes and write a descriptive commit message',
    argHint: 'optional intent',
    expand: (arg) =>
      'Review the current changes, stage them, and create a git commit with a ' +
      'clear, descriptive message that explains the why.' +
      (arg ? ` Context: ${arg}.` : ''),
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
    description: 'Summarize the conversation to free up context',
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

/** The placeholder a plugin slash template uses for the trailing argument. */
export const SLASH_ARGUMENTS_TOKEN = '$ARGUMENTS';

/**
 * Convert a plugin's slash contribution (a prompt TEMPLATE, never a closure —
 * design §R1/§5) into a {@link SlashPromptCommand}. The name is namespaced
 * `pluginId:name` so it can't collide with a built-in, and `expand` substitutes
 * every `$ARGUMENTS` occurrence with the trailing text the user typed.
 */
export function pluginSlashCommand(
  pluginId: string,
  c: { name: string; description: string; argHint?: string; template: string },
): SlashPromptCommand {
  return {
    kind: 'prompt',
    name: `${pluginId}:${c.name}`.toLowerCase(),
    description: c.description,
    argHint: c.argHint,
    expand: (arg) => c.template.split(SLASH_ARGUMENTS_TOKEN).join(arg),
  };
}

// Slash tokens may contain `:` so plugin commands (`/myplugin:foo`) parse.
/** True when `text` is the start of a slash-command invocation (leading `/`). */
export function isSlashInvocation(text: string): boolean {
  return /^\/[^\s]*$/.test(text) || /^\/[a-zA-Z][\w:-]*\s/.test(text);
}

/** The token typed right after the leading slash, used to filter the menu. */
export function slashQuery(text: string): string | null {
  const m = /^\/([a-zA-Z][\w:-]*)?$/.exec(text);
  return m ? (m[1] ?? '') : null;
}

function matchesName(cmd: SlashCommand, token: string): boolean {
  if (cmd.name === token) return true;
  return (cmd.aliases ?? []).includes(token);
}

/** Resolve a fully-typed command line (`/review auth`) to its command + arg. */
export function resolveSlash(
  text: string,
  extra: readonly SlashCommand[] = [],
): { command: SlashCommand; arg: string } | null {
  const m = /^\/([a-zA-Z][\w:-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const token = m[1].toLowerCase();
  const arg = (m[2] ?? '').trim();
  const command = [...SLASH_COMMANDS, ...extra].find((c) => matchesName(c, token));
  return command ? { command, arg } : null;
}

/** Filter commands by the current query token (prefix match on name/alias). */
export function filterSlash(query: string, extra: readonly SlashCommand[] = []): SlashCommand[] {
  const all = [...SLASH_COMMANDS, ...extra];
  const q = query.toLowerCase();
  if (q === '') return all;
  return all.filter((c) => [c.name, ...(c.aliases ?? [])].some((n) => n.startsWith(q)));
}
