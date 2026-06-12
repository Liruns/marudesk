import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isProviderId, type ProviderId } from '../../shared/providers';
import { firstLine, parseFrontmatter } from './skills-store';
import type { McpTool, ToolContext, ToolResult } from './tools';

/**
 * Agents — named subagent roles the model can spawn (oh-my-openagents-style).
 * An agent definition bundles what a delegated child should BE: a role system
 * prompt, an optional tool allowlist, and a model preference (a concrete
 * provider/model, or a cost tier resolved against whichever providers the user
 * actually has connected — see subagent-resolve.ts).
 *
 * Three scopes, later shadows earlier on a name clash:
 *   - builtin: the roles defined below, always available.
 *   - user:    `<userData>/agents/<name>.md` (or `<name>/AGENT.md`)
 *   - project: `<workspace>/.marudesk/agents/<name>.md` (or `<name>/AGENT.md`)
 *
 * AGENT.md format mirrors SKILL.md: optional `---`-fenced frontmatter with
 * `name`, `description`, `model` (`fast` | `smart` | `inherit` |
 * `<provider>/<model>`), and `tools` (comma/space-separated tool names); the
 * markdown body becomes the child's extra system instructions. The chat model
 * discovers agents through the read-only `list_agents` tool and uses one by
 * passing `agent: "<name>"` to spawn_subagent / spawn_background_agent.
 */

const MAX_AGENT_SYSTEM = 8_000;
const MAX_AGENTS = 100;

export type AgentScope = 'builtin' | 'user' | 'project';

export type AgentTier = 'fast' | 'smart' | 'inherit';

export type AgentModelPref =
  | { kind: 'tier'; tier: AgentTier }
  | { kind: 'explicit'; provider: ProviderId; model: string };

export type AgentDef = {
  name: string;
  description: string;
  scope: AgentScope;
  modelPref: AgentModelPref;
  /** Tool-name allowlist narrowing the child-safe toolset; null = the full child set. */
  tools: readonly string[] | null;
  /** Extra system instructions appended to the child system prompt; null = none. */
  system: string | null;
  /** Absolute source file for user/project agents — set from a trusted scan only. */
  file?: string;
};

/**
 * The built-in roles. Tool allowlists only ever SUBTRACT from the child-safe
 * read-only envelope (listChildToolDefs), so a typo'd name can't grant anything.
 */
export const BUILTIN_AGENTS: AgentDef[] = [
  {
    name: 'explore',
    description: 'Fast codebase exploration — find files, symbols, and usage patterns, report locations and conclusions.',
    scope: 'builtin',
    modelPref: { kind: 'tier', tier: 'fast' },
    tools: ['read_file', 'list_files', 'grep', 'list_workspace_files', 'read_workspace_file'],
    system:
      'You are a codebase exploration specialist. Locate the files, symbols, and usage patterns the task asks about, reading only what you need. Report concrete paths (with line numbers where useful) and a short conclusion — not file dumps.',
  },
  {
    name: 'researcher',
    description: 'Web research — search, fetch, and cross-check sources, then report findings with references.',
    scope: 'builtin',
    modelPref: { kind: 'tier', tier: 'fast' },
    tools: ['web_search', 'fetch_url', 'read_file', 'list_files', 'grep'],
    system:
      'You are a web research specialist. Search broadly, fetch the most authoritative sources, and cross-check claims before reporting them. Cite the source URL next to each finding and call out anything you could not verify.',
  },
  {
    name: 'reviewer',
    description: 'Code review — inspect a change or area for correctness bugs, risks, and concrete improvements.',
    scope: 'builtin',
    modelPref: { kind: 'tier', tier: 'smart' },
    tools: ['read_file', 'list_files', 'grep', 'read_diagnostics', 'read_workspace_file', 'list_workspace_files'],
    system:
      'You are a code reviewer. Read the relevant code closely and report correctness bugs, edge cases, and risky patterns first, then meaningful simplifications. For each finding give the file:line, why it is a problem, and a concrete fix. Do not pad the report with style nits.',
  },
  {
    name: 'planner',
    description: 'Implementation planning — research the codebase and propose a step-by-step plan with file-level detail.',
    scope: 'builtin',
    modelPref: { kind: 'tier', tier: 'smart' },
    tools: null,
    system:
      'You are a software architect. Research the relevant code read-only, then return a step-by-step implementation plan: which files to touch, in what order, the key types/functions involved, and the risks or open questions the implementer should watch for.',
  },
  {
    name: 'general',
    description: 'General-purpose delegate — the full child-safe toolset on the parent (or delegate) model.',
    scope: 'builtin',
    modelPref: { kind: 'tier', tier: 'inherit' },
    tools: null,
    system: null,
  },
];

/* ── user/project discovery ─────────────────────────────────────────────── */

function parseModelPref(value: string | undefined): AgentModelPref {
  const v = (value ?? '').trim();
  if (!v || v === 'inherit') return { kind: 'tier', tier: 'inherit' };
  if (v === 'fast' || v === 'smart') return { kind: 'tier', tier: v };
  // `<provider>/<model>` — the model id itself may contain '/' (openrouter,
  // fireworks), so split on the FIRST slash only.
  const slash = v.indexOf('/');
  if (slash > 0) {
    const provider = v.slice(0, slash).trim();
    const model = v.slice(slash + 1).trim();
    if (isProviderId(provider) && model) return { kind: 'explicit', provider, model };
  }
  return { kind: 'tier', tier: 'inherit' };
}

function parseToolList(value: string | undefined): readonly string[] | null {
  if (!value) return null;
  const names = value
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  return names.length > 0 ? names : null;
}

async function readAgentFromFile(
  file: string,
  fallbackName: string,
  scope: AgentScope,
): Promise<AgentDef | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const { meta, body } = parseFrontmatter(raw);
  const name = (meta.name || fallbackName).trim();
  if (!name) return null;
  const system = body.trim().slice(0, MAX_AGENT_SYSTEM);
  return {
    name,
    description: meta.description || firstLine(body) || '(no description)',
    scope,
    modelPref: parseModelPref(meta.model),
    tools: parseToolList(meta.tools),
    system: system || null,
    file,
  };
}

/** Discover agents in one root dir: `<name>/AGENT.md` subdirs + flat `<name>.md`. */
async function scanDir(root: string, scope: AgentScope): Promise<AgentDef[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: AgentDef[] = [];
  for (const e of entries) {
    if (out.length >= MAX_AGENTS) break;
    if (e.isDirectory()) {
      const def = await readAgentFromFile(path.join(root, e.name, 'AGENT.md'), e.name, scope);
      if (def) out.push(def);
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md') && e.name.toLowerCase() !== 'readme.md') {
      const def = await readAgentFromFile(path.join(root, e.name), e.name.replace(/\.md$/i, ''), scope);
      if (def) out.push(def);
    }
  }
  return out;
}

function userAgentsDir(): string {
  return path.join(app.getPath('userData'), 'agents');
}
function projectAgentsDir(ws: ToolContext['ws']): string | null {
  return ws ? path.join(ws.root, '.marudesk', 'agents') : null;
}

/**
 * All available agents: builtin ← user ← project (later shadows earlier on a
 * name clash), sorted builtins-first then by name. Best-effort IO.
 */
export async function listAgents(ws: ToolContext['ws']): Promise<AgentDef[]> {
  const projectDir = projectAgentsDir(ws);
  const [user, project] = await Promise.all([
    scanDir(userAgentsDir(), 'user'),
    projectDir ? scanDir(projectDir, 'project') : Promise.resolve([]),
  ]);
  const byName = new Map<string, AgentDef>();
  for (const a of BUILTIN_AGENTS) byName.set(a.name, a);
  for (const a of user) byName.set(a.name, a);
  for (const a of project) byName.set(a.name, a);
  return [...byName.values()].sort((a, b) => {
    const builtinFirst = Number(b.scope === 'builtin') - Number(a.scope === 'builtin');
    return builtinFirst !== 0 ? builtinFirst : a.name.localeCompare(b.name);
  });
}

/** Resolve one agent by name (exact, then case-insensitive), or null. */
export async function findAgent(name: string, ws: ToolContext['ws']): Promise<AgentDef | null> {
  const agents = await listAgents(ws);
  return (
    agents.find((a) => a.name === name) ??
    agents.find((a) => a.name.toLowerCase() === name.toLowerCase()) ??
    null
  );
}

function modelPrefLabel(pref: AgentModelPref): string {
  return pref.kind === 'explicit' ? `${pref.provider}/${pref.model}` : pref.tier;
}

/** One agent as a list line — shared by the tool below and error messages. */
export function agentCatalogLine(a: AgentDef): string {
  return `- ${a.name} [${a.scope} · model: ${modelPrefLabel(a.modelPref)}] — ${a.description}`;
}

/* ── the `list_agents` tool ─────────────────────────────────────────────── */

async function listAgentsTool(_input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const agents = await listAgents(ctx.ws);
  const where = ctx.ws
    ? `${path.join(ctx.ws.root, '.marudesk', 'agents')}/<name>.md or ${userAgentsDir()}/<name>.md`
    : `${userAgentsDir()}/<name>.md`;
  const lines = agents.map(agentCatalogLine);
  return {
    summary: `${agents.length} agent${agents.length === 1 ? '' : 's'}`,
    text:
      `Available subagent roles (pass agent: "<name>" to spawn_subagent or spawn_background_agent):\n${lines.join('\n')}\n\n` +
      `Tier models ("fast"/"smart") are resolved automatically against the user's connected providers. ` +
      `Users can define their own agents as markdown files under ${where}.`,
  };
}

/** The agents catalog tool, merged into the built-in marudesk MCP server. */
export const AGENT_LIST_TOOLS: McpTool[] = [
  {
    name: 'list_agents',
    group: 'agent',
    description:
      'List the subagent roles available to spawn_subagent / spawn_background_agent — built-in roles (explore, researcher, reviewer, planner, general) plus any user-defined agents. Read-only. Check this when delegating work so each subtask runs on the right role and model tier.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    exec: listAgentsTool as McpTool['exec'],
  },
];
