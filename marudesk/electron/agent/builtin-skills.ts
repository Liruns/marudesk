/**
 * Built-in skills — playbooks shipped with the app (lowest precedence; a user
 * or project skill with the same name shadows them). Kept as in-memory string
 * constants rather than packaged files so discovery needs no fs access and the
 * bodies survive asar packaging untouched. See skills-store.ts for the
 * discovery/merge rules and the `skill` gateway tool.
 */

export type BuiltinSkill = {
  name: string;
  description: string;
  body: string;
};

const SAVE_REGRESSION_TEST_BODY = `
# Save a verified fix as a Playwright regression test

You just fixed a runtime problem and verified it (e.g. via reload_and_verify /
get_console_errors / screenshot). Turn that verified loop into a permanent
regression test so the fix cannot silently break again.

## 1. Gather the facts from THIS conversation
- The page route/URL where the problem reproduced (strip the dev-server origin;
  keep the path + query).
- The reproduction steps you actually performed: every click / fill / press_key /
  scroll / reload call and its selector or target, in order.
- The error signature that is now fixed: the console error message (or network
  failure / wrong UI state) exactly as it appeared before the fix.
- The expected healthy state after the fix (visible text, element state, no
  console error).

## 2. Detect the workspace test setup
- Look for \`playwright.config.*\` and an \`e2e/\` or \`tests/\` directory, and a
  \`@playwright/test\` devDependency in package.json.
- If Playwright is configured: add the spec under the existing test dir, in a
  \`regressions/\` subfolder (create it if missing).
- If Playwright is NOT configured: do not install dependencies silently — tell
  the user what you would add (\`npm i -D @playwright/test\` + a minimal
  \`playwright.config.ts\` with \`use.baseURL\` pointing at their dev server) and
  ask before adding it (use ask_user if mid-turn).

## 3. Write the spec
- Name: \`regressions/<short-kebab-slug-of-the-bug>.spec.ts\`.
- Shape:
  - \`page.goto('<route>')\` (rely on baseURL; never hard-code localhost ports
    inside the test body — put the origin in config or an env fallback).
  - Replay the reproduction interactions. Prefer resilient selectors:
    role-based (\`getByRole\`), label/text, or existing \`data-testid\` attributes —
    inspect the live DOM (query_dom) to pick the most stable one. Avoid brittle
    CSS chains.
  - Collect runtime errors for the assertion:
    \`\`\`ts
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    \`\`\`
  - Assert the FIXED error signature does not reappear (match a stable
    substring of the old message, not the whole stack), AND assert at least one
    positive expectation about the healthy UI state (text/element visible).
- Keep one bug per spec file; add a one-line comment linking the symptom
  ("regression: <original error message>") so future readers know what it guards.

## 4. Verify
- If the dev server is running and Playwright is installed, run just the new
  spec (\`npx playwright test <file>\`) via run_command and report the result.
- If it cannot run here, say exactly how to run it and what it asserts.
`.trim();

const WRITE_PLUGIN_BODY = `
# Write a MaruDesk plugin

You can extend MaruDesk itself by authoring a plugin into this workspace. A
plugin is a folder with a \`manifest.json\` and an \`index.js\` (CommonJS) that
exports \`activate(ctx)\`. Plugins run in an isolated worker — never in the main
process — and reach the filesystem/network only through a capability-gated
bridge the user approves per plugin.

## 1. Scaffold

Create \`.marudesk/plugins/<plugin-id>/\` in the workspace root with:

\`manifest.json\`:
\`\`\`json
{
  "id": "<plugin-id>",
  "name": "<Display Name>",
  "version": "0.1.0",
  "description": "<one line — what it contributes>",
  "main": "index.js",
  "engine": { "marudesk": "^1.0.0" },
  "permissions": ["tools"]
}
\`\`\`

- \`permissions\` — request ONLY what the plugin needs:
  - \`"tools"\` — contribute agent tools (ctx.registerTool)
  - \`"commands"\` — contribute slash commands (ctx.registerSlashCommand)
  - \`"fs:read"\` / \`"fs:write"\` — workspace-relative file access via ctx.fs
  - \`"net"\` — host-mediated HTTP via ctx.http.fetch (raw network modules are
    always denied, even with this grant)
  - \`"ui"\` — an optional panel (add \`"panel": { "title": "...", "entry": "panel.html" }\`)

\`index.js\` (CommonJS — the worker loads it with require()):
\`\`\`js
module.exports = {
  activate(ctx) {
    ctx.registerTool({
      name: 'my_tool',
      description: 'What the model should know about when/why to call this.',
      inputSchema: {
        type: 'object',
        properties: { arg: { type: 'string', description: '...' } },
        required: ['arg'],
      },
      async handler(input) {
        // Validate input defensively — it comes from the model.
        const arg = input && typeof input.arg === 'string' ? input.arg : '';
        return \`result text the model will read\`;
      },
    });
    ctx.registerSlashCommand({
      name: 'mycmd',
      description: 'Shown in the slash menu',
      argHint: 'what to pass',
      template: 'Prompt text where $ARGUMENTS is replaced with user input.',
    });
    ctx.log('activated'); // host-side log, for debugging
  },
};
\`\`\`

## 2. ctx surface (gated by granted permissions)
- \`ctx.registerTool({ name, description, inputSchema, handler })\` — handler
  returns a string (or Promise<string>); it runs inside the agent's normal
  approval flow.
- \`ctx.registerSlashCommand({ name, description, argHint, template })\` —
  \`$ARGUMENTS\` is substituted with the user's text.
- \`ctx.fs.read(relPath)\` / \`ctx.fs.list(relPath)\` / \`ctx.fs.write(relPath, content)\`
  — workspace-relative, root-contained (escapes are refused). Writes go through
  the agent's patch flow, so they appear in the chat diff/revert history.
- \`ctx.http.fetch(url)\` → \`{ status, text }\` — only with \`"net"\`.
- \`ctx.log(...args)\` — debug logging.

## 3. Rules
- Keep handlers fast and side-effect-minimal; throw an Error with a clear
  message on failure (the model sees it).
- Request minimal permissions — the user approves them per plugin and over-asking
  erodes trust.
- Tool names must be snake_case and not collide with built-ins (read_file,
  grep, eval_js, …) — prefix with the plugin domain when generic.
- No Node builtins for network/process: raw \`net\`/\`http\`/\`child_process\`
  requires are denied by the worker sandbox regardless of permissions.

## 4. Hand off
After writing the files, tell the user: the plugin appears in
Settings → Plugins (workspace plugins are scanned from \`.marudesk/plugins/\`),
where they enable it and approve its capabilities. A reload of the plugin list
may be needed. Offer to iterate if a tool errors at activation (check the
plugin's log output in Settings → Plugins).
`.trim();

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    name: 'save-regression-test',
    description:
      'Turn the runtime fix you just verified into a permanent Playwright regression test in the workspace (route + replayed interactions + "error signature gone" assertion).',
    body: SAVE_REGRESSION_TEST_BODY,
  },
  {
    name: 'write-plugin',
    description:
      'Author a MaruDesk plugin (manifest.json + index.js) into .marudesk/plugins/ — contribute agent tools or slash commands with minimal capability grants.',
    body: WRITE_PLUGIN_BODY,
  },
];
