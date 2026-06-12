import {
  ASK_USER,
  SPAWN_SUBAGENT,
  SPAWN_BACKGROUND_AGENT,
  COLLECT_BACKGROUND_AGENT,
  CANCEL_BACKGROUND_AGENT,
  UPDATE_PLAN,
  type ToolSchema,
} from './types';
import { BROWSER_TOOL_SCHEMAS } from './browser-schemas';
import { boolProp, intProp, strProp } from './schema-helpers';

/**
 * JSON-Schema (Anthropic `input_schema`) for every built-in tool, including the
 * loop-intercepted `ask_user`. The descriptions are part of the tool contract
 * the model reads, so keep them precise; the MCP descriptor layer (registry.ts)
 * pairs these with executors + metadata.
 */

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 workspace file (relative path). Output is line-numbered WITH a per-line hash anchor: each line is "N <hash>\\t<text>", and everything before the tab (the number and the hash) is NOT part of the file. Large files are paged: read the next chunk with offset set to the line after the last one shown (the footer tells you when there is more). To edit, either copy the verbatim text after the tab as oldString, OR pass that line\'s <hash> as edit_file\'s "anchor" (token-cheap, unambiguous). An edit to a file that changed since you read it is refused — re-read it for fresh anchors.',
    inputSchema: { type: 'object', properties: { path: strProp('Workspace-relative path.'), offset: intProp('1-based line number to start reading from (default 1).'), limit: intProp('Maximum lines to return (default 1500).') }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'list_files',
    description: 'List indexed workspace files, optionally filtered by a glob (e.g. "src/**/*.tsx"). At most 300 paths are returned — when the footer says more matched, narrow with a glob rather than re-calling.',
    inputSchema: { type: 'object', properties: { glob: strProp('Optional glob; * and ** supported.') }, additionalProperties: false },
  },
  {
    name: 'grep',
    description: 'Search file contents across the workspace (skips binary files). Literal substring by default; set regex=true to treat pattern as a JavaScript regular expression. Case-insensitive unless caseSensitive=true. Returns path:line: text. Narrow with a glob.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: strProp('Text to find — a literal substring, or a JS regular expression when regex=true.'),
        glob: strProp('Optional path glob to narrow the search.'),
        regex: boolProp('Treat pattern as a JS regular expression (default false).'),
        caseSensitive: boolProp('Match case-sensitively (default false).'),
        maxResults: { type: 'number', description: 'Cap on hits (default 60, max 200).' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_file',
    description: 'Apply ONE replace edit, two ways: (1) verbatim — oldString is a unique substring of the current file; set oldString="" to create a new file with newString as its contents. (2) anchored — pass "anchor" (a line\'s <hash> from read_file) to replace that whole line with newString (token-cheap, unambiguous); add "endAnchor" to replace the span of lines from anchor through endAnchor. With an anchor, oldString may be "". A stale anchor (the line changed since you read it) is refused — re-read for fresh anchors. Atomic.',
    inputSchema: {
      type: 'object',
      properties: {
        path: strProp('Workspace-relative path.'),
        oldString: strProp('Unique verbatim substring to replace (or "" to create, or "" when using anchor).'),
        newString: strProp('Replacement (or full contents for a new file).'),
        anchor: strProp('Optional line <hash> from read_file: replace that line (instead of oldString).'),
        endAnchor: strProp('Optional line <hash>: with anchor, replace the span of lines from anchor through this line (inclusive).'),
      },
      required: ['path', 'oldString', 'newString'],
      additionalProperties: false,
    },
  },
  {
    name: 'multi_edit',
    description: 'Apply several replace edits across one or more files atomically (all-or-nothing). Each edit is verbatim (oldString) or anchored (anchor / endAnchor line hashes from read_file) — same rules as edit_file. Prefer this when a fix spans multiple sites.',
    inputSchema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: strProp('Workspace-relative path.'),
              oldString: strProp('Unique substring (or "" to create, or "" when using anchor).'),
              newString: strProp('Replacement.'),
              anchor: strProp('Optional line <hash> from read_file: replace that line.'),
              endAnchor: strProp('Optional line <hash>: span from anchor through this line (inclusive).'),
            },
            required: ['path', 'oldString', 'newString'],
            additionalProperties: false,
          },
        },
      },
      required: ['edits'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_command',
    description:
      "Run a shell command in the workspace root and return its combined stdout+stderr and exit status. Requires user approval each call. Use this to run the PROJECT'S OWN checks — type-check, lint, build, tests (e.g. `npm run typecheck`, `tsc --noEmit`, `eslint .`, `cargo check`, `go build ./...`, `pytest`). It uses the project's real config, so the diagnostics are trustworthy — prefer it over guessing whether code compiles. The command must terminate on its own: long-running servers will hit the timeout, so keep it to finite checks/builds. Mutating commands (installs, codegen) are fine but run real code, hence the approval.",
    inputSchema: {
      type: 'object',
      properties: {
        command: strProp('Shell command to run, e.g. "npm run typecheck".'),
        timeoutMs: intProp('Max run time in ms (default 120000, min 1000, max 600000).'),
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_diagnostics',
    description:
      "Run the PROJECT'S OWN checker (type-check/lint) now and return the parsed errors + warnings as file:line findings. Requires user approval (it executes the project's tooling). This also refreshes the shared cache — the user's Problems indicator and in-editor squiggles update from this call — so prefer it over a bare run_command when you want structured diagnostics that the user sees too. Optionally filter the returned list to one file with `path`.",
    inputSchema: {
      type: 'object',
      properties: { path: strProp('Optional workspace-relative path to filter findings to.') },
      additionalProperties: false,
    },
  },
  {
    name: 'read_diagnostics',
    description:
      "Read the latest CACHED compiler/linter diagnostics (errors + warnings) for the workspace, as produced by the PROJECT'S OWN checker and parsed into file:line findings — the same results shown in the Problems indicator. Read-only: it does NOT run anything. If nothing is cached yet, use run_diagnostics first. Optionally filter to one file with `path`.",
    inputSchema: {
      type: 'object',
      properties: { path: strProp('Optional workspace-relative path to filter findings to.') },
      additionalProperties: false,
    },
  },
  ...BROWSER_TOOL_SCHEMAS,
  {
    name: SPAWN_SUBAGENT,
    description: 'Delegate a self-contained read-only subtask to a bounded child agent. The parent turn waits for the child report, so use this for focused second opinions and bounded analysis. To fan out, issue SEVERAL spawn_subagent calls in the SAME assistant turn — independent children then execute concurrently. For detached work that outlives the turn, use spawn_background_agent instead. Prefer naming an agent role: built-ins are explore (fast codebase search), researcher (fast web research), reviewer (smart code review), planner (smart implementation planning), general; list_agents shows the full catalog including user-defined roles. The model is resolved automatically against the user\'s CONNECTED providers (with rate-limit fail-over), so omit provider/model unless the task truly needs a specific one. The child may inspect workspace/live context and search the web (web_search, fetch_url) with non-mutating built-in tools, cannot edit, update the visible plan, ask the user, call external MCP/plugin tools, or run other gated actions.',
    inputSchema: {
      type: 'object',
      properties: {
        task: strProp('Self-contained instructions for the child agent.'),
        agent: strProp('Optional agent role name (see list_agents): explore | researcher | reviewer | planner | general | a user-defined agent. Sets the child\'s role instructions, tool subset, and model tier.'),
        provider: strProp('Optional provider id. Omit to auto-resolve from the agent role / connected providers — that is the normal choice.'),
        model: strProp('Optional model id, or the tier sentinel "fast"/"smart". Omit to auto-resolve — that is the normal choice.'),
        label: strProp('Optional short label for the child result card.'),
        maxSteps: { type: 'number', description: 'Optional child loop step cap (default 6, max 12).' },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: SPAWN_BACKGROUND_AGENT,
    description:
      'Delegate a self-contained, READ-ONLY subtask to a DETACHED background agent (optionally on an agent role or a different provider/model — the model is resolved against the user\'s connected providers, like spawn_subagent). Returns IMMEDIATELY with a task id; the agent keeps running after this turn ends. Use for long research fan-out or fire-and-forget investigation you will read later with collect_background_agent. The background agent may use read-only built-in tools and web research (web_search, fetch_url), but cannot edit, update the visible plan, ask the user, call external MCP/plugin tools, run other gated actions, or spawn further agents.',
    inputSchema: {
      type: 'object',
      properties: {
        task: strProp('Self-contained instructions for the background agent.'),
        agent: strProp('Optional agent role name (see list_agents) — sets role instructions, tool subset, and model tier.'),
        provider: strProp('Optional provider id; omit to auto-resolve from the agent role / connected providers.'),
        model: strProp('Optional model id, or the tier sentinel "fast"/"smart"; omit to auto-resolve.'),
        label: strProp('Optional short label for the background tray entry.'),
        maxSteps: { type: 'number', description: 'Optional child loop step cap (default 6, max 12).' },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: COLLECT_BACKGROUND_AGENT,
    description:
      'Fetch the status and (when finished) final report of background agents started this conversation. Pass an id to collect one, or omit to list them all. Reading a finished agent marks it collected.',
    inputSchema: {
      type: 'object',
      properties: { id: strProp('Optional task id; omit to list all background agents.') },
      additionalProperties: false,
    },
  },
  {
    name: CANCEL_BACKGROUND_AGENT,
    description: 'Cancel a running background agent by id. No-op if it already finished.',
    inputSchema: {
      type: 'object',
      properties: { id: strProp('The background task id to cancel.') },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: UPDATE_PLAN,
    description:
      'Maintain a visible task plan for multi-step work (roughly 3+ steps). Call it once to post your plan, then call again to update step statuses as you go — keep about one step in_progress at a time. Each call REPLACES the whole plan with the steps you pass. Optional for simple tasks; skip it for trivial ones.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'The full ordered list of steps (replaces any previous plan).',
          items: {
            type: 'object',
            properties: {
              title: strProp('Short imperative description of the step.'),
              status: { type: 'string', enum: ['pending', 'in_progress', 'done'], description: 'Step status.' },
              note: strProp('Optional one-line detail or result.'),
            },
            required: ['title', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
  },
  {
    name: ASK_USER,
    description: 'Ask the user one or more questions and wait for their answer. Use when the request is ambiguous or you need a decision before continuing.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: { question: strProp('The question.'), options: { type: 'array', items: { type: 'string' }, description: 'Optional suggested answers.' } },
            required: ['question'],
            additionalProperties: false,
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
  },
];
