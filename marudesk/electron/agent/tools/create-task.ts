import { randomId } from '../../../shared/id';
import { getHost } from '../../browser/state';
import type { McpTool, ToolResult } from './types';

/**
 * `create_task` — let the agent draw its plan as Work-OS task nodes on the
 * canvas while it works (docs/ai-work-os-roadmap.md). Each call materializes one
 * node; chaining `depends_on` between calls renders the flow left→right. Main
 * mints the id (so the agent can reference it in a later task's `depends_on`
 * without a round-trip) and the renderer places the node in free space beside its
 * dependency — never on top of an open tab card.
 *
 * Display-only: it visualizes intent, it doesn't run anything. So it is not
 * gated and needs no workspace.
 */

function strProp(description: string): { type: 'string'; description: string } {
  return { type: 'string', description };
}

function stringList(input: unknown, cap: number): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out = input
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, cap);
  return out.length > 0 ? out : undefined;
}

async function createTaskTool(input: Record<string, unknown>): Promise<ToolResult> {
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 200) : '';
  if (!title) {
    return { summary: 'create_task failed', text: 'create_task requires a non-empty "title".', isError: true };
  }
  const intent = typeof input.intent === 'string' ? input.intent.trim().slice(0, 2000) : undefined;
  const acceptance = stringList(input.acceptance, 12);
  // Accept either depends_on (model-facing snake_case) or dependsOn (lenient).
  const dependsOn = stringList(input.depends_on ?? input.dependsOn, 24);
  const goal = typeof input.goal === 'string' ? input.goal.trim().slice(0, 2000) : undefined;

  const id = randomId('task');
  const host = getHost();
  if (!host || host.isDestroyed()) {
    return { summary: 'create_task failed', text: 'The app window is unavailable to draw the task.', isError: true };
  }
  host.webContents.send('workos:create-task', { id, title, intent, acceptance, dependsOn, goal });

  const dep = dependsOn?.length ? ` It depends on ${dependsOn.join(', ')}.` : '';
  return {
    summary: `task: ${title}`,
    text:
      `Added the task "${title}" (id ${id}) to the canvas task graph.${dep} ` +
      `Reference this id as a later task's depends_on to draw the dependency flow.`,
  };
}

export const CREATE_TASK_TOOL: McpTool = {
  name: 'create_task',
  description:
    "Draw a task node on the user's canvas to visualize your plan as you work. Call it once per concrete step (decompose a goal into a few tasks), giving a short imperative `title`, an optional `intent` (why it exists), optional `acceptance` checks, and `depends_on` — the ids returned by earlier create_task calls this task must follow. The graph lays out left→right by dependency and is placed in empty space, never over the user's open tabs. This is a planning/visualization aid only; it does not execute anything.",
  inputSchema: {
    type: 'object',
    properties: {
      title: strProp('Short imperative task title, e.g. "Implement the login endpoint".'),
      intent: strProp('Optional one-line reason this task exists (the goal context).'),
      acceptance: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional acceptance criteria (how you know it is done).',
      },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ids of tasks (from earlier create_task calls) that must complete first.',
      },
      goal: strProp('Optional overall goal — seeds the graph the first time you create a task.'),
    },
    required: ['title'],
    additionalProperties: false,
  },
  group: 'agent',
  gated: false,
  write: false,
  requiresWorkspace: false,
  exec: createTaskTool,
};
