import { ASK_USER, SPAWN_SUBAGENT, type ToolSchema } from './types';

/**
 * JSON-Schema (Anthropic `input_schema`) for every built-in tool, including the
 * loop-intercepted `ask_user`. The descriptions are part of the tool contract
 * the model reads, so keep them precise; the MCP descriptor layer (registry.ts)
 * pairs these with executors + metadata.
 */

const strProp = (desc: string) => ({ type: 'string', description: desc });
const intProp = (desc: string) => ({ type: 'integer', description: desc });
const boolProp = (desc: string) => ({ type: 'boolean', description: desc });

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 workspace file (relative path). Output is line-numbered ("N\\t<text>") for reference only — those number+tab prefixes are NOT part of the file. Large files are paged: read the next chunk with offset set to the line after the last one shown (the footer tells you when there is more). Read before editing: your oldString must match the file text exactly (without the prefixes), and an edit to a file that changed since you read it is refused until you re-read it.',
    inputSchema: { type: 'object', properties: { path: strProp('Workspace-relative path.'), offset: intProp('1-based line number to start reading from (default 1).'), limit: intProp('Maximum lines to return (default 1500).') }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'list_files',
    description: 'List indexed workspace files, optionally filtered by a glob (e.g. "src/**/*.tsx").',
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
    description: 'Apply ONE string-replace edit. oldString must be a unique verbatim substring of the current file; set oldString="" to create a new file with newString as its contents. Atomic.',
    inputSchema: {
      type: 'object',
      properties: { path: strProp('Workspace-relative path.'), oldString: strProp('Unique substring to replace (or "" to create).'), newString: strProp('Replacement (or full contents for a new file).') },
      required: ['path', 'oldString', 'newString'],
      additionalProperties: false,
    },
  },
  {
    name: 'multi_edit',
    description: 'Apply several string-replace edits across one or more files atomically (all-or-nothing). Prefer this when a fix spans multiple sites.',
    inputSchema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: strProp('Workspace-relative path.'), oldString: strProp('Unique substring (or "" to create).'), newString: strProp('Replacement.') },
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
    name: 'get_console_errors',
    description: 'Read the live page\'s captured runtime errors (always-on). Each carries a confidence-tagged source file when its stack maps deterministically to a workspace file. Start here for a "fix this error" task.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max errors (default 20).' } }, additionalProperties: false },
  },
  {
    name: 'query_dom',
    description: 'Inspect the live DOM: returns the matched element\'s outerHTML + key computed styles. Read-only.',
    inputSchema: { type: 'object', properties: { selector: strProp('CSS selector.') }, required: ['selector'], additionalProperties: false },
  },
  {
    name: 'eval_js',
    description: 'Evaluate a JavaScript expression in the live page and return the result. Powerful — requires user approval each call. Use for runtime probing you cannot get from query_dom/get_console_errors.',
    inputSchema: { type: 'object', properties: { expression: strProp('JS expression to evaluate.') }, required: ['expression'], additionalProperties: false },
  },
  {
    name: 'click',
    description: 'Click an element in the active web tab. selector is a CSS selector — use query_dom first to find one. Scrolls the element into view, then clicks. Requires user approval each call.',
    inputSchema: { type: 'object', properties: { selector: strProp('CSS selector of the element to click.') }, required: ['selector'], additionalProperties: false },
  },
  {
    name: 'fill',
    description: 'Set the value of an input, textarea, or contenteditable in the active web tab (React-compatible — fires input/change so framework state updates). selector is a CSS selector; find one with query_dom first. Requires user approval each call.',
    inputSchema: { type: 'object', properties: { selector: strProp('CSS selector of the field.'), value: strProp('Text to set as the field value.') }, required: ['selector', 'value'], additionalProperties: false },
  },
  {
    name: 'press_key',
    description: 'Dispatch a key press (keydown+keyup) in the active web tab — e.g. "Enter", "Escape", "Tab", "ArrowDown". Targets the selector element (focused first) or the focused element if no selector. Good for submitting forms / triggering key handlers. Requires user approval each call.',
    inputSchema: { type: 'object', properties: { key: strProp('Key name, e.g. "Enter", "Escape", "Tab", "ArrowDown".'), selector: strProp('Optional CSS selector to focus and target; defaults to the focused element.') }, required: ['key'], additionalProperties: false },
  },
  {
    name: 'scroll',
    description: 'Scroll the active web tab. With a selector (CSS), smooth-scrolls that element into view; without one, scrolls the window a screenful in the given direction. Requires user approval each call.',
    inputSchema: { type: 'object', properties: { selector: strProp('Optional CSS selector to scroll into view.'), direction: { type: 'string', enum: ['up', 'down'], description: "Window scroll direction when no selector (default 'down')." } }, additionalProperties: false },
  },
  {
    name: 'read_network',
    description: 'List recent network responses/failures captured from the live page (lazily enables capture). For TRIAGE: a failing status is often backend/infra, not a frontend bug. Secrets in URLs/headers are scrubbed.',
    inputSchema: { type: 'object', properties: { urlFilter: strProp('Optional substring to filter URLs.'), max: { type: 'number', description: 'Max rows (default 40).' } }, additionalProperties: false },
  },
  {
    name: 'read_network_body',
    description: 'Fetch a captured response body by requestId (from read_network). Secrets are scrubbed. Use to inspect a malformed response shape (e.g. "10%" where a number was expected).',
    inputSchema: { type: 'object', properties: { requestId: strProp('requestId from read_network.') }, required: ['requestId'], additionalProperties: false },
  },
  {
    name: 'reload_and_verify',
    description: 'Reload the page, wait for it to settle, then re-read the console. REQUIRED after editing to fix a runtime error — pass the error message as errorSignature to confirm it is GONE or STILL PRESENT. This closed loop is how you prove a fix worked.',
    inputSchema: {
      type: 'object',
      properties: { waitMs: { type: 'number', description: 'Settle wait, max 5000 (default 2500).' }, errorSignature: strProp('A substring of the error you expect to be gone.') },
      additionalProperties: false,
    },
  },
  {
    name: 'browser_cookies',
    description: "Read the live page's cookies (name, value, domain, flags). Read-only; values are secret-scrubbed. Requires user approval. Use to debug auth/session state.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browser_storage',
    description: "Read the live page's localStorage and/or sessionStorage entries. Read-only; values are secret-scrubbed. Requires user approval.",
    inputSchema: { type: 'object', properties: { kind: strProp("'local', 'session', or omit for both.") }, additionalProperties: false },
  },
  {
    name: SPAWN_SUBAGENT,
    description: 'Delegate a self-contained read-only subtask to a bounded child agent. The child may inspect workspace/live context with non-mutating tools, cannot edit or run gated actions, and returns a final report to the parent. Use for parallel research, second opinions, and splitting analysis work.',
    inputSchema: {
      type: 'object',
      properties: {
        task: strProp('Self-contained instructions for the child agent.'),
        provider: strProp('Optional provider id; defaults to the parent turn provider.'),
        model: strProp('Optional model id; defaults to the parent turn model.'),
        label: strProp('Optional short label for the child result card.'),
        maxSteps: { type: 'number', description: 'Optional child loop step cap (default 4, max 6).' },
      },
      required: ['task'],
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
