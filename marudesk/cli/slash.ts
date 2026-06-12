import { SLASH_COMMANDS, type SlashActionId } from '../shared/slash-commands';

/**
 * The CLI's slash-command registry (chat CLI v2 — docs/chat-cli-tui-design.md
 * §5). Prompt commands come VERBATIM from shared/slash-commands.ts so the CLI
 * and the desktop composer can't drift on what `/review` etc. expand to; the
 * desktop's renderer-resolved actions are mapped to CLI-local actions where an
 * equivalent exists, dropped where it doesn't (listed by /help as desktop-only),
 * and the CLI adds its own session/connection commands.
 */

export type CliActionId =
  | 'help'
  | 'model'
  | 'new'
  | 'sessions'
  | 'resume'
  | 'workspace'
  | 'history'
  | 'status'
  | 'approval-mode'
  | 'exit';

export type CliSlashCommand = {
  name: string;
  aliases?: string[];
  description: string;
  argHint?: string;
} & (
  | { kind: 'action'; action: CliActionId }
  | { kind: 'prompt'; expand: (arg: string) => string }
);

/** Desktop composer actions with a CLI-local equivalent. */
const ACTION_MAP: Partial<Record<SlashActionId, CliActionId>> = {
  new: 'new',
  model: 'model',
  help: 'help',
  context: 'status',
};

/** Desktop-only actions, surfaced by /help so users know where to find them. */
export const DESKTOP_ONLY = ['diff', 'copy', 'compact'] as const;

const CLI_COMMANDS: CliSlashCommand[] = [
  {
    kind: 'action',
    name: 'sessions',
    description: 'List saved conversations and resume one',
    action: 'sessions',
  },
  {
    kind: 'action',
    name: 'resume',
    description: 'Resume a saved conversation by id',
    argHint: 'session id',
    action: 'resume',
  },
  {
    kind: 'action',
    name: 'workspace',
    aliases: ['ws'],
    description: 'Switch workspace (syncs sessions with the desktop panel)',
    action: 'workspace',
  },
  {
    kind: 'action',
    name: 'history',
    description: 'View conversation transcript of a session',
    argHint: 'session id',
    action: 'history',
  },
  {
    kind: 'action',
    name: 'approval-mode',
    description: 'Set how much the agent may do without asking',
    argHint: 'read-only | ask | auto | plan',
    action: 'approval-mode',
  },
  {
    kind: 'action',
    name: 'exit',
    aliases: ['quit'],
    description: 'Leave the chat CLI',
    action: 'exit',
  },
];

function fromShared(): CliSlashCommand[] {
  const out: CliSlashCommand[] = [];
  for (const cmd of SLASH_COMMANDS) {
    if (cmd.kind === 'prompt') {
      out.push({
        kind: 'prompt',
        name: cmd.name,
        aliases: cmd.aliases,
        description: cmd.description,
        argHint: cmd.argHint,
        expand: cmd.expand,
      });
      continue;
    }
    const action = ACTION_MAP[cmd.action];
    if (action) {
      out.push({
        kind: 'action',
        name: cmd.name,
        aliases: cmd.aliases,
        description: cmd.description,
        argHint: cmd.argHint,
        action,
      });
    }
  }
  return out;
}

/** Every command the CLI offers, shared prompts first, CLI-locals appended. */
export function cliSlashCommands(): CliSlashCommand[] {
  return [...fromShared(), ...CLI_COMMANDS];
}

/** Filter by the token typed after `/` (prefix match on name/alias). */
export function filterCliSlash(query: string): CliSlashCommand[] {
  const q = query.toLowerCase();
  const all = cliSlashCommands();
  if (q === '') return all;
  return all.filter((c) => [c.name, ...(c.aliases ?? [])].some((n) => n.startsWith(q)));
}

/** Resolve a fully-typed `/command arg…` line, or null when it isn't one. */
export function resolveCliSlash(text: string): { command: CliSlashCommand; arg: string } | null {
  const m = /^\/([a-zA-Z][\w:-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const token = m[1].toLowerCase();
  const arg = (m[2] ?? '').trim();
  const command = cliSlashCommands().find(
    (c) => c.name === token || (c.aliases ?? []).includes(token),
  );
  return command ? { command, arg } : null;
}

/** The query token while typing a command (`/mo` → 'mo'), or null once spaced. */
export function cliSlashQuery(text: string): string | null {
  const m = /^\/([a-zA-Z][\w:-]*)?$/.exec(text);
  return m ? (m[1] ?? '') : null;
}
