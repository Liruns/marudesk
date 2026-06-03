import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { McpTool, ToolContext, ToolResult } from './tools';

/**
 * Skills — reusable instruction "playbooks" the agent can load on demand
 * (absorbed from hermes-agent / oh-my-openagent; the agentskills.io convention).
 * A skill is a `SKILL.md` file with optional YAML-ish frontmatter (`name`,
 * `description`, …) followed by a markdown body of instructions. The agent
 * discovers what's available, then loads one — its body is returned as the tool
 * result, injecting the playbook into context right before related work.
 *
 * Discovery scopes (project shadows user on a name clash):
 *   - project: `<workspace>/.marudesk/skills/<name>/SKILL.md` (or a flat `<name>.md`)
 *   - user:    `<userData>/skills/<name>/SKILL.md` (or a flat `<name>.md`)
 *
 * Exposed as ONE gateway tool (`skill`) rather than one tool per skill, so the
 * model's tool list never bloats with the skill catalog (oh-my-openagent's
 * single-`skill_mcp`-tool pattern). All IO is best-effort.
 */

const MAX_SKILL_BODY = 16_000;
const MAX_SKILLS = 200;

export type SkillScope = 'project' | 'user';

export type SkillMeta = {
  name: string;
  description: string;
  scope: SkillScope;
  /** Absolute path to the SKILL.md (or flat .md) file — set from a trusted scan,
   * never from model input. */
  file: string;
};

const strProp = (desc: string) => ({ type: 'string', description: desc });

/** Parse leading `---`-fenced frontmatter into a flat key→string map + the body. */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const fenced = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
  const m = fenced.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    // Only flat scalar values are read (name/description/version/…); strip wrapping quotes.
    meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2] ?? '' };
}

/** First non-empty, non-heading body line — the description fallback. */
function firstLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith('#')) return t.slice(0, 200);
  }
  return '';
}

async function readMetaFromFile(file: string, fallbackName: string, scope: SkillScope): Promise<SkillMeta | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    const name = (meta.name || fallbackName).trim();
    if (!name) return null;
    return { name, description: meta.description || firstLine(body) || '(no description)', scope, file };
  } catch {
    return null;
  }
}

/** Discover skills in one root dir: `<name>/SKILL.md` subdirs + flat `<name>.md`. */
async function scanDir(root: string, scope: SkillScope): Promise<SkillMeta[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillMeta[] = [];
  for (const e of entries) {
    if (out.length >= MAX_SKILLS) break;
    if (e.isDirectory()) {
      const meta = await readMetaFromFile(path.join(root, e.name, 'SKILL.md'), e.name, scope);
      if (meta) out.push(meta);
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md') && e.name.toLowerCase() !== 'readme.md') {
      const meta = await readMetaFromFile(path.join(root, e.name), e.name.replace(/\.md$/i, ''), scope);
      if (meta) out.push(meta);
    }
  }
  return out;
}

function userSkillsDir(): string {
  return path.join(app.getPath('userData'), 'skills');
}
function projectSkillsDir(ws: ToolContext['ws']): string | null {
  return ws ? path.join(ws.root, '.marudesk', 'skills') : null;
}

/**
 * All discovered skills. Project skills shadow user skills of the same name; the
 * result is sorted by name. Used by the `skill` tool's list mode.
 */
export async function listSkills(ws: ToolContext['ws']): Promise<SkillMeta[]> {
  const projectDir = projectSkillsDir(ws);
  const [project, user] = await Promise.all([
    projectDir ? scanDir(projectDir, 'project') : Promise.resolve([]),
    scanDir(userSkillsDir(), 'user'),
  ]);
  const byName = new Map<string, SkillMeta>();
  for (const s of user) byName.set(s.name, s);
  for (const s of project) byName.set(s.name, s); // project wins
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ── the `skill` gateway tool ───────────────────────────────────────────── */

async function skillTool(input: { name?: unknown }, ctx: ToolContext): Promise<ToolResult> {
  const skills = await listSkills(ctx.ws);
  const wantName = typeof input.name === 'string' ? input.name.trim() : '';

  if (!wantName) {
    if (skills.length === 0) {
      const where = ctx.ws
        ? `${path.join(ctx.ws.root, '.marudesk', 'skills')}/<name>/SKILL.md or ${userSkillsDir()}/<name>/SKILL.md`
        : `${userSkillsDir()}/<name>/SKILL.md`;
      return {
        summary: 'skills: none',
        text: `No skills found. Add a SKILL.md (frontmatter \`name\`/\`description\` + a markdown body of instructions) under ${where}.`,
      };
    }
    const lines = skills.map((s) => `- ${s.name} [${s.scope}] — ${s.description}`);
    return {
      summary: `${skills.length} skill${skills.length === 1 ? '' : 's'}`,
      text: `Available skills (call skill with {name} to load one before related work):\n${lines.join('\n')}`,
    };
  }

  // Match against the trusted scan by exact name — never build a path from input.
  const found =
    skills.find((s) => s.name === wantName) ??
    skills.find((s) => s.name.toLowerCase() === wantName.toLowerCase());
  if (!found) {
    return {
      summary: `skill ${wantName} not found`,
      text: `No skill named "${wantName}". Call skill with no arguments to list what's available.`,
      isError: true,
    };
  }
  let raw: string;
  try {
    raw = await fs.readFile(found.file, 'utf8');
  } catch {
    return { summary: `skill ${found.name} unreadable`, text: `Could not read skill "${found.name}".`, isError: true };
  }
  const { body } = parseFrontmatter(raw);
  const clipped = body.length > MAX_SKILL_BODY ? `${body.slice(0, MAX_SKILL_BODY)}\n…[clipped]` : body;
  return {
    summary: `loaded skill "${found.name}"`,
    text: `## Skill: ${found.name}\n(${found.scope} · ${found.file})\n\nFollow these instructions for this task:\n\n${clipped.trim()}`,
  };
}

/** The skill gateway tool, merged into the built-in marudesk MCP server. */
export const SKILL_TOOLS: McpTool[] = [
  {
    name: 'skill',
    group: 'skills',
    description:
      'Load a reusable instruction "skill" (a saved playbook) before doing related work. Call with NO arguments to list available skills (name + description); call with {name} to load that skill — its full instructions are returned for you to follow. Check for a relevant skill when a task matches one.',
    inputSchema: {
      type: 'object',
      properties: { name: strProp('Skill name to load; omit to list available skills.') },
      additionalProperties: false,
    },
    exec: skillTool as McpTool['exec'],
  },
];
