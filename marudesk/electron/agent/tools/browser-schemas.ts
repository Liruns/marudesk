import type { ToolSchema } from './types';
import { strProp } from './schema-helpers';

export const BROWSER_TOOL_SCHEMAS: ToolSchema[] = [
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
    description: 'Evaluate a JavaScript expression in the live page and return the result. Promises are awaited; return JSON-serializable data (a DOM node comes back as a bare description, so map nodes to plain values first, e.g. [...document.querySelectorAll(s)].map(e => e.textContent)). Output is clipped to ~12k chars. Powerful — requires user approval each call. Use for runtime probing you cannot get from query_dom/get_console_errors.',
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
];
