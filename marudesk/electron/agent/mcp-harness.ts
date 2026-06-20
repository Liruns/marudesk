import { check, passedCount } from '../harness-kit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isHttpMcpConfig,
  MAX_MCP_MODEL_TOOL_NAME,
  mcpDisplayTarget,
  mcpTransportOf,
  sanitizeMcpConfig,
  type McpServerConfig,
} from '../../shared/mcp';
import { callMcpTool, isWriteTool, listMcpTools } from './mcp';
import type { ToolContext, ToolResult } from './tools';
import {
  parseBoundedWebSearchJsonForTests,
  setWebSearchHtmlTransportForTests,
  setWebSearchTransportForTests,
  WEB_SEARCH_MAX_RESPONSE_BYTES_FOR_TESTS,
} from './tools/web-search';
import { htmlToText, isBlockedHost, setFetchUrlTransportForTests } from './tools/fetch-url';
import { updateContextCache } from './context-cache';
import {
  buildExternalServer,
  buildCapabilityTools,
  connectServer,
  disposeExternalMcpServers,
  listMcpServerStatuses,
  setReconnectSchedulerForTests,
  syncExternalMcpServers,
  toToolResult,
  type McpCallToolResult,
  type McpClientLike,
  type McpExternalToolInfo,
  type McpPromptInfo,
} from './mcp-external';
import { startHttpMockServer } from './mcp-mock-http-server';

/**
 * Headless harness for the external MCP connector (docs/context-mcp-design §8).
 * Mirrors electron/cli-bridge/harness.ts (run with `node --experimental-strip-types`,
 * see package.json `harness:mcp`); a small resolve hook stubs the bare `electron`
 * import and adds `.ts` resolution so the agent module chain loads without Electron.
 *
 * It exercises the manager every way:
 *  - PURE: `sanitizeMcpConfig` over the stdio/http/sse config union (trust,
 *    disabledTools, URL validation, dedupe);
 *  - against a MOCK client (deterministic spy) for the routing/result/isError/
 *    namespacing/unregister/trust/filter/crash + status-field assertions;
 *  - against the REAL `StdioClientTransport` + a tiny in-repo mock MCP server
 *    (mcp-mock-server.ts) for a true end-to-end spawn + protocol round-trip;
 *  - against the REAL `StreamableHTTPClientTransport` + an in-process HTTP mock
 *    server (mcp-mock-http-server.ts) for a true remote round-trip;
 *
 * plus a real spawn of a bogus command to prove graceful failure.
 *
 * Asserts: (a) an enabled server's tools appear namespaced `<id>__<tool>` with
 * gated:true (or ungated when trusted); (b) calling a wrapped tool routes to
 * client.callTool and maps the result + isError into a ToolResult; (c) a server that
 * fails to connect is handled gracefully (no throw; errored status); (d)
 * disabling/unregistering/crash removes its tools.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = path.join(__dirname, 'mcp-mock-server.ts');

/** A fake MCP client that records callTool invocations — for the routing assertions. */
function makeMockClient(): {
  client: McpClientLike;
  calls: { name: string; arguments?: Record<string, unknown> }[];
  closed: () => boolean;
} {
  const calls: { name: string; arguments?: Record<string, unknown> }[] = [];
  let isClosed = false;
  const tools: McpExternalToolInfo[] = [
    {
      name: 'echo',
      description: 'Echo it back.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    { name: 'boom', description: 'Errors.', inputSchema: { type: 'object', properties: {} } },
  ];
  const client: McpClientLike = {
    async listTools() {
      return { tools };
    },
    async callTool(params): Promise<McpCallToolResult> {
      calls.push({ name: params.name, arguments: params.arguments });
      if (params.name === 'echo') {
        const text = typeof params.arguments?.text === 'string' ? params.arguments.text : '';
        return { content: [{ type: 'text', text: `echo: ${text}` }] };
      }
      if (params.name === 'boom') {
        return { content: [{ type: 'text', text: 'kaboom' }], isError: true };
      }
      return { content: [{ type: 'text', text: 'unknown' }], isError: true };
    },
    async close() {
      isClosed = true;
    },
  };
  return { client, calls, closed: () => isClosed };
}

/**
 * A mock client that advertises the `prompts` + `resources` capabilities and
 * implements their methods — for the capability-bridge (synthesized meta-tool)
 * assertions. Kept separate from {@link makeMockClient} so the existing tools-only
 * assertions (toolCount === 2, tools === [echo, boom]) stay unaffected.
 */
type RichMockClientOptions = {
  readonly tools?: readonly McpExternalToolInfo[];
  readonly prompts?: readonly {
    readonly name: string;
    readonly description?: string;
    readonly arguments?: readonly { readonly name: string; readonly required?: boolean }[];
  }[];
  readonly promptText?: string;
  readonly resources?: readonly {
    readonly uri: string;
    readonly name?: string;
    readonly title?: string;
    readonly mimeType?: string;
  }[];
  readonly resourceBody?: string;
};

function makeRichMockClient(options: RichMockClientOptions = {}): McpClientLike {
  const tools: McpExternalToolInfo[] = [...(options.tools ?? [
    { name: 'echo', description: 'Echo.', inputSchema: { type: 'object', properties: {} } },
  ])];
  const prompts: McpPromptInfo[] = (options.prompts ?? [
    { name: 'greet', description: 'Say hi', arguments: [{ name: 'who', required: true }] },
  ]).map((prompt) => ({
    name: prompt.name,
    ...(prompt.description ? { description: prompt.description } : {}),
    ...(prompt.arguments ? { arguments: prompt.arguments.map((arg) => ({ ...arg })) } : {}),
  }));
  const resources = options.resources ?? [{ uri: 'mem://note', name: 'Note', mimeType: 'text/plain' }];
  const promptText = options.promptText ?? 'hi';
  const resourceBody = options.resourceBody ?? 'resource body';
  return {
    async listTools() {
      return { tools: [...tools] };
    },
    async callTool() {
      return { content: [{ type: 'text', text: 'ok' }] };
    },
    async close() {},
    getServerCapabilities() {
      return { tools: {}, prompts: {}, resources: {} };
    },
    async listPrompts() {
      return { prompts: [...prompts] };
    },
    async getPrompt(params) {
      const who = typeof params.arguments?.who === 'string' ? params.arguments.who : '';
      return {
        description: 'Greeting prompt',
        messages: [{ role: 'user', content: { type: 'text', text: `${promptText} ${who}`.trim() } }],
      };
    },
    async listResources() {
      return { resources: [...resources] };
    },
    async readResource(params) {
      return { contents: [{ uri: params.uri, mimeType: 'text/plain', text: resourceBody }] };
    },
  };
}

function makeLargeCapabilityText(seed: string): string {
  return `${seed} sk-ant-1234567890abcdefghijklmnop ${'0123456789'.repeat(1_300)}\nsentinel-after-limit`;
}

// The tool context the loop would pass; external tools only use input + the SDK
// client, so a minimal ws-less context is enough for the harness.
const ctx: ToolContext = { ws: null, signal: new AbortController().signal };

async function main(): Promise<void> {
  /* ── unit: sanitizeMcpConfig — stdio default, http/sse, trust, disabledTools ─ */
  {
    const { servers } = sanitizeMcpConfig({
      servers: [
        // stdio (no transport field) — the classic Claude-Desktop shape.
        { id: 'local', command: 'npx', args: ['-y', 'some-server'], env: { TOKEN: 's3cret' } },
        // explicit http transport.
        { id: 'remote', transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
        // http inferred from a url + no command.
        { id: 'inferred', url: 'https://api.example.com/v1/mcp' },
        // sse transport with trust + disabledTools + autoApproveTools + confirmTools.
        { id: 'sse1', transport: 'sse', url: 'http://localhost:9000/sse', trust: true, disabledTools: ['danger', '  '], autoApproveTools: ['safe', '  '], confirmTools: ['deploy', '  '] },
        // invalid: http transport but a non-http url → dropped.
        { id: 'bad-url', transport: 'http', url: 'ftp://nope' },
        // invalid: neither command nor url → dropped.
        { id: 'empty', enabled: true },
        // invalid: id would exceed provider tool-name limits once exposed.
        { id: 'x'.repeat(MAX_MCP_MODEL_TOOL_NAME + 1), command: 'too-long' },
        // duplicate id → second dropped (first wins).
        { id: 'local', command: 'other' },
      ],
    });
    const byId = new Map(servers.map((s) => [s.id, s] as const));
    check('sanitize: keeps the valid entries, drops the bad ones', servers.length === 4);
    check('sanitize: stdio entry has no transport (defaults to stdio)', mcpTransportOf(byId.get('local')!) === 'stdio');
    check('sanitize: explicit http transport preserved', byId.get('remote')?.transport === 'http');
    check('sanitize: http inferred from url when no command', mcpTransportOf(byId.get('inferred')!) === 'http');
    check('sanitize: sse transport preserved', byId.get('sse1')?.transport === 'sse');
    check('sanitize: trust flag parsed', byId.get('sse1')?.trust === true);
    check(
      'sanitize: disabledTools trimmed + blanks dropped',
      JSON.stringify(byId.get('sse1')?.disabledTools) === JSON.stringify(['danger']),
    );
    check(
      'sanitize: autoApproveTools trimmed + blanks dropped',
      JSON.stringify(byId.get('sse1')?.autoApproveTools) === JSON.stringify(['safe']),
    );
    check(
      'sanitize: confirmTools trimmed + blanks dropped',
      JSON.stringify(byId.get('sse1')?.confirmTools) === JSON.stringify(['deploy']),
    );
    check('sanitize: non-http url for http transport is dropped', !byId.has('bad-url'));
    check('sanitize: entry with neither command nor url is dropped', !byId.has('empty'));
    check('sanitize: overlong server id is dropped', !servers.some((s) => s.id.length > MAX_MCP_MODEL_TOOL_NAME));
    check('sanitize: duplicate id keeps the first (command "npx")', (() => {
      const l = byId.get('local');
      return !!l && 'command' in l && l.command === 'npx';
    })());
    check(
      'sanitize: http display target strips query/secrets to origin+path',
      mcpDisplayTarget(byId.get('remote')!) === 'https://example.com/mcp',
    );
  }

  /* ── unit: buildExternalServer namespacing + gated + schema passthrough ──── */
  {
    const { client } = makeMockClient();
    const server = buildExternalServer('myserver', client, [
      { name: 'echo', description: 'd', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    ]);
    check('buildExternalServer names the server by id', server.name === 'myserver');
    const tool = server.tools[0];
    check('(a) tool is namespaced <id>__<tool>', tool.name === 'myserver__echo');
    check('(a) external tool is gated:true', tool.gated === true);
    check('external tool is group "mcp"', tool.group === 'mcp');
    check('external tool is NOT marked write (gating is the control)', !tool.write);
    check(
      'tool schema is passed through from the server',
      JSON.stringify(tool.inputSchema) ===
        JSON.stringify({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }),
    );
  }

  /* ── unit: exec routes to client.callTool + maps result / isError ────────── */
  {
    const { client, calls } = makeMockClient();
    const server = buildExternalServer('srv', client, [
      { name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
      { name: 'boom', inputSchema: { type: 'object', properties: {} } },
    ]);
    const echo = server.tools.find((t) => t.name === 'srv__echo')!;
    const out = await echo.exec({ text: 'hi' }, ctx);
    check('(b) exec routed to client.callTool with the un-namespaced tool name', calls[0]?.name === 'echo');
    check('(b) exec forwarded the input as arguments', calls[0]?.arguments?.text === 'hi');
    check('(b) text content mapped into ToolResult.text', out.text.includes('echo: hi'));
    check('(b) successful result is not an error', out.isError !== true);

    const boom = server.tools.find((t) => t.name === 'srv__boom')!;
    const errOut = await boom.exec({}, ctx);
    check('(b) isError result maps to ToolResult.isError', errOut.isError === true);
    check('(b) error result still carries its text', errOut.text.includes('kaboom'));
  }

  /* ── unit: toToolResult maps text / image / resource / link / structured ──── */
  {
    const big = 'A'.repeat(4096); // ~3 KB decoded
    const out = toToolResult('t', {
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', mimeType: 'image/png', data: big },
        { type: 'resource_link', uri: 'file:///x.ts', name: 'x.ts', mimeType: 'text/plain' },
        { type: 'resource', resource: { uri: 'mem://note', text: 'inline body' } },
        { type: 'resource', resource: { uri: 'blob://b', mimeType: 'application/pdf', blob: big } },
        { type: 'weird', foo: 1 },
      ],
    });
    check('content: text part is kept verbatim', out.text.includes('hello'));
    check('content: image noted with mime + size, blob not inlined', /\[image image\/png, [\d.]+ KB\]/.test(out.text) && !out.text.includes(big));
    check('content: resource_link surfaces name + uri', out.text.includes('[resource link "x.ts": file:///x.ts'));
    check('content: embedded text resource is inlined', out.text.includes('[resource mem://note]') && out.text.includes('inline body'));
    check('content: binary resource noted with mime + size, blob not inlined', out.text.includes('[resource blob://b (application/pdf)') && out.text.includes('KB]'));
    check('content: unknown type keeps the omitted fallback', out.text.includes('[weird content omitted]'));

    const structured = toToolResult('t', { structuredContent: { ok: true, n: 2 } });
    check('content: structuredContent stringified when no content parts', structured.text.includes('"ok":true') && structured.text.includes('"n":2'));

    const empty = toToolResult('t', {});
    check('content: empty result yields "(no content)"', empty.text === '(no content)');
  }

  /* ── unit: trust → ungated, disabledTools filtered out ──────────────────── */
  {
    const { client } = makeMockClient();
    const trusted = buildExternalServer('t', client, [
      { name: 'echo', inputSchema: { type: 'object', properties: {} } },
      { name: 'boom', inputSchema: { type: 'object', properties: {} } },
    ], { trusted: true, disabledTools: ['boom'] });
    check('trust: a trusted server exposes its tools UN-gated', trusted.tools.every((t) => t.gated !== true));
    check('disabledTools: a hidden tool is filtered out entirely', !trusted.tools.some((t) => t.name === 't__boom'));
    check('disabledTools: the remaining tool is still present', trusted.tools.some((t) => t.name === 't__echo'));
  }

  /* ── unit: tool annotations → write flag derivation + title in description ── */
  {
    const { client } = makeMockClient();
    const server = buildExternalServer('ann', client, [
      { name: 'read_thing', title: 'Read Thing', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } },
      { name: 'delete_thing', annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { type: 'object', properties: {} } },
      { name: 'mutate', annotations: { readOnlyHint: false }, inputSchema: { type: 'object', properties: {} } },
      { name: 'plain', inputSchema: { type: 'object', properties: {} } },
    ]);
    const byName = new Map(server.tools.map((t) => [t.name, t] as const));
    check('annotations: readOnlyHint tool is NOT write (callable in read-only)', byName.get('ann__read_thing')?.write !== true);
    check('annotations: destructiveHint tool IS write (refused in read-only)', byName.get('ann__delete_thing')?.write === true);
    check('annotations: non-read-only tool IS write', byName.get('ann__mutate')?.write === true);
    check('annotations: tool without annotations stays non-write (back-compat)', byName.get('ann__plain')?.write !== true);
    check('annotations: title surfaced in the tool description', byName.get('ann__read_thing')?.description.includes('Read Thing') === true);
  }

  /* ── unit: per-tool autoApproveTools un-gates specific tools ──────────────── */
  {
    const { client } = makeMockClient();
    const server = buildExternalServer('aa', client, [
      { name: 'safe', inputSchema: { type: 'object', properties: {} } },
      { name: 'risky', inputSchema: { type: 'object', properties: {} } },
    ], { autoApproveTools: ['safe'] });
    const byName = new Map(server.tools.map((t) => [t.name, t] as const));
    check('autoApprove: an allow-listed tool is un-gated', byName.get('aa__safe')?.gated === false);
    check('autoApprove: a non-listed tool on the same server stays gated', byName.get('aa__risky')?.gated === true);
  }

  /* ── unit: per-tool confirmTools keeps gating ON even for a trusted server ── */
  {
    const { client } = makeMockClient();
    const server = buildExternalServer('ct', client, [
      { name: 'read', inputSchema: { type: 'object', properties: {} } },
      { name: 'deploy', inputSchema: { type: 'object', properties: {} } },
    ], { trusted: true, confirmTools: ['deploy'] });
    const byName = new Map(server.tools.map((t) => [t.name, t] as const));
    check('confirmTools: a confirm-listed tool stays gated despite trust', byName.get('ct__deploy')?.gated === true);
    check('confirmTools: other tools on the trusted server stay un-gated', byName.get('ct__read')?.gated === false);
  }

  /* ── unit: confirmTools wins over autoApproveTools (deny beats allow) ──────── */
  {
    const { client } = makeMockClient();
    const server = buildExternalServer('cw', client, [
      { name: 'tool', inputSchema: { type: 'object', properties: {} } },
    ], { autoApproveTools: ['tool'], confirmTools: ['tool'] });
    check(
      'confirmTools: a tool both auto-approved and confirm-listed stays gated',
      server.tools[0]?.gated === true,
    );
  }

  /* ── integration: status carries transport / target / trusted / tools ────── */
  {
    const { client } = makeMockClient();
    const cfg: McpServerConfig = {
      id: 'meta',
      transport: 'http',
      url: 'https://host.example/mcp?token=secret',
      trust: true,
      enabled: true,
    };
    const statuses = await syncExternalMcpServers([cfg], async () => ({ client }));
    const s = statuses.find((x) => x.id === 'meta');
    check('status: reports the transport (http)', s?.transport === 'http');
    check('status: target strips the query/secret (origin+path only)', s?.target === 'https://host.example/mcp');
    check('status: reflects the trust flag', s?.trusted === true);
    check('status: lists the exposed tool names (un-namespaced)', JSON.stringify(s?.tools) === JSON.stringify(['echo', 'boom']));
    await syncExternalMcpServers([], async () => ({ client }));
  }

  /* ── crash detection: an unexpected transport close drops the tools ──────── */
  {
    // Capture (don't run) the backoff retry so the drop's immediate effect is what
    // we assert — the dedicated reconnect blocks below exercise the recovery path.
    const queue: (() => Promise<void>)[] = [];
    setReconnectSchedulerForTests((run) => {
      queue.push(run);
    });
    const { client } = makeMockClient();
    const cfg: McpServerConfig = { id: 'crashy', command: 'noop', enabled: true };
    await syncExternalMcpServers([cfg], async () => ({ client }));
    check('crash: tool is live before the drop', listMcpTools().some((t) => t.name === 'crashy__echo'));
    // Simulate the transport dropping (process exit / network loss).
    check('crash: connectServer wired an onclose handler', typeof client.onclose === 'function');
    client.onclose?.();
    const s = listMcpServerStatuses().find((x) => x.id === 'crashy');
    check('crash: the server is marked "reconnecting" after the drop', s?.state === 'reconnecting');
    check('crash: its tools are removed from the model list', !listMcpTools().some((t) => t.name === 'crashy__echo'));
    await syncExternalMcpServers([], async () => ({ client }));
    setReconnectSchedulerForTests(null);
  }

  /* ── integration via injected connect: sync registers + lists namespaced ── */
  {
    const { client, closed } = makeMockClient();
    const cfg: McpServerConfig = { id: 'inj', command: 'noop', enabled: true };
    const connect = async () => ({ client });
    const statuses = await syncExternalMcpServers([cfg], connect);
    const s = statuses.find((x) => x.id === 'inj');
    check('(a) sync reports the server connected', s?.state === 'connected');
    check('(a) sync reports the tool count', s?.toolCount === 2);

    const listed = listMcpTools().map((t) => t.name);
    check('(a) listMcpTools exposes the namespaced tool to the model', listed.includes('inj__echo'));
    check('built-in marudesk tools are still present (server untouched)', listed.includes('read_file'));
    check('built-in workspace MCP list tool is present', listed.includes('list_workspaces'));
    check('built-in workspace MCP file lister is present', listed.includes('list_workspace_files'));
    check('built-in workspace MCP file reader is present', listed.includes('read_workspace_file'));
    check('built-in web search tool is present', listed.includes('web_search'));
    check(
      'built-in web search requires per-call approval',
      listMcpTools().find((t) => t.name === 'web_search')?.gated === true,
    );
    check('built-in ask_user is still listed', listed.includes('ask_user'));

    let capturedSearchQuery = '';
    let capturedSearchSignalWasLive = false;
    setWebSearchTransportForTests(async (url, signal) => {
      capturedSearchQuery = url.searchParams.get('q') ?? '';
      capturedSearchSignalWasLive = !signal.aborted;
      return {
        Heading: 'Marudesk',
        AbstractText: 'A desktop shell with agent chat.',
        AbstractURL: 'https://example.test/marudesk',
        RelatedTopics: [
          {
            Text: 'Marudesk docs - Agent chat reference.',
            FirstURL: 'https://example.test/marudesk/docs',
          },
          {
            Text: 'Marudesk docs duplicate - Duplicate URL should be deduped.',
            FirstURL: 'https://example.test/marudesk/docs',
          },
          {
            Text: 'Marudesk changelog - Recent releases.',
            FirstURL: 'https://example.test/marudesk/changelog',
          },
        ],
      };
    });
    const webOut = await callMcpTool('web_search', { query: 'marudesk ai chat', maxResults: 2 }, ctx);
    check('web_search executes through the MCP tool registry', webOut.summary.includes('marudesk ai chat'));
    check('web_search forwards the bounded query to the provider', capturedSearchQuery === 'marudesk ai chat');
    check('web_search passes a live abort signal to its provider', capturedSearchSignalWasLive);
    check('web_search formats source URLs for the model', webOut.text.includes('https://example.test/marudesk'));
    check('web_search formats related topic snippets', webOut.text.includes('Agent chat reference'));
    const webUrlCount = webOut.text.match(/URL:/g)?.length ?? 0;
    check('web_search respects maxResults after dedupe', webUrlCount === 2);

    setWebSearchTransportForTests(async () => {
      throw new Error('search provider unavailable: Bearer sk-123456789012345678901234');
    });
    const failedWebOut = await callMcpTool('web_search', { query: 'marudesk failure' }, ctx);
    check('web_search provider failure returns a tool error', failedWebOut.isError === true);
    check('web_search failure returns a generic provider message', failedWebOut.text === 'Search provider request failed.');
    check('web_search failure omits raw provider error text', !failedWebOut.text.includes('search provider unavailable'));
    check('web_search failure scrubs provider secrets', !failedWebOut.text.includes('sk-123456789012345678901234'));
    let oversizeError = '';
    try {
      parseBoundedWebSearchJsonForTests([Buffer.alloc(WEB_SEARCH_MAX_RESPONSE_BYTES_FOR_TESTS + 1)]);
    } catch (err) {
      oversizeError = err instanceof Error ? err.message : '';
    }
    check('web_search bounded parser rejects oversized provider responses', oversizeError.includes('too large'));
    let invalidJsonError = '';
    try {
      parseBoundedWebSearchJsonForTests([Buffer.from('{')]);
    } catch (err) {
      invalidJsonError = err instanceof Error ? err.message : '';
    }
    check('web_search bounded parser rejects invalid provider JSON with safe text', invalidJsonError === 'Search provider returned invalid JSON.');
    setWebSearchTransportForTests(null);

    updateContextCache({
      editors: [
        {
          path: 'workspace-alpha:root-be:src/App.tsx',
          dirty: true,
          content: 'export const source = "unsaved be";',
        },
      ],
      explorer: { root: null, expandedDirs: [], selectedPath: null },
    });
    const editorOut = await callMcpTool(
      'read_editor',
      { workspaceId: 'workspace-alpha', rootId: 'root-be', path: 'src/App.tsx' },
      {} as ToolContext,
    );
    check(
      'built-in read_editor accepts workspace/root selectors for mirrored buffers',
      editorOut.text.includes('unsaved be'),
    );

    // (d) disabling removes its tools and closes the client.
    const disabled = await syncExternalMcpServers([{ ...cfg, enabled: false }], connect);
    const ds = disabled.find((x) => x.id === 'inj');
    check('(d) disabled server reports state "disabled"', ds?.state === 'disabled');
    check('(d) disabling closed the client transport', closed());
    check(
      '(d) disabled server tools are gone from listMcpTools',
      !listMcpTools().map((t) => t.name).includes('inj__echo'),
    );

    // Removing it entirely drops its status row too.
    const removed = await syncExternalMcpServers([], connect);
    check('(d) removed server drops out of the status list', !removed.some((x) => x.id === 'inj'));
  }

  /* ── remote (Streamable-HTTP) transport: a `url` config connects over http ── */
  {
    const { client } = makeMockClient();
    const url = 'https://mcp.example.com/mcp';
    const cfg: McpServerConfig = { id: 'remote', transport: 'http', url, enabled: true };
    let capturedUrl = '';
    const connect = async (c: McpServerConfig) => {
      capturedUrl = isHttpMcpConfig(c) ? c.url : '';
      return { client };
    };
    const statuses = await syncExternalMcpServers([cfg], connect);
    const s = statuses.find((x) => x.id === 'remote');
    check('(http) remote server connects', s?.state === 'connected');
    check('(http) status transport is "http"', s?.transport === 'http');
    check('(http) status target is the url', s?.target === url);
    check('(http) connect received the url config', capturedUrl === url);
    check(
      '(http) remote tool is namespaced + listed',
      listMcpTools().map((t) => t.name).includes('remote__echo'),
    );
    await syncExternalMcpServers([], connect); // cleanup
  }

  /* ── graceful failure: a server that fails to spawn (injected throw) ─────── */
  {
    const largeError = makeLargeCapabilityText('connect');
    const cfg: McpServerConfig = { id: 'broken', command: 'noop', enabled: true };
    const connect = async (): Promise<{ client: McpClientLike }> => {
      throw new Error('spawn failed: command not found');
    };
    let threw = false;
    let status;
    try {
      status = await connectServer(cfg, connect);
    } catch {
      threw = true;
    }
    check('(c) connectServer did NOT throw on a spawn failure', !threw);
    check('(c) failed server is marked state "error"', status?.state === 'error');
    check('(c) failed server contributes no tools', status?.toolCount === 0);
    check(
      '(c) a failed server does not appear in the model tool list',
      !listMcpTools().map((t) => t.name).includes('broken__'),
    );
    await disposeExternalMcpServers();

    const longConnectCfg: McpServerConfig = { id: 'broken_long', command: 'noop', enabled: true };
    const longConnectStatus = await connectServer(longConnectCfg, async () => {
      throw new Error(largeError);
    });
    const longConnectError = longConnectStatus.error ?? '';
    check('(c) connect error status scrubs token-shaped secrets', !longConnectError.includes('sk-ant-1234567890abcdefghijklmnop') && longConnectError.includes('redacted'));
    check('(c) connect error status clips oversized messages', longConnectError.includes('clipped') && !longConnectError.includes('sentinel-after-limit'));

    const listToolsClient: McpClientLike = {
      async listTools() {
        throw new Error(largeError);
      },
      async callTool() {
        return { content: [{ type: 'text', text: 'ok' }] };
      },
      async close() {},
    };
    const listToolsStatus = await connectServer(
      { id: 'listed_long', command: 'noop', enabled: true },
      async () => ({ client: listToolsClient }),
    );
    const listToolsError = listToolsStatus.error ?? '';
    check('(c) listTools error status scrubs token-shaped secrets', !listToolsError.includes('sk-ant-1234567890abcdefghijklmnop') && listToolsError.includes('redacted'));
    check('(c) listTools error status clips oversized messages', listToolsError.includes('clipped') && !listToolsError.includes('sentinel-after-limit'));
  }

  /* ── end-to-end: REAL StdioClientTransport against the in-repo mock server ─ */
  {
    const cfg: McpServerConfig = {
      id: 'real',
      command: process.execPath,
      args: ['--experimental-strip-types', MOCK_SERVER],
      enabled: true,
    };
    const statuses = await syncExternalMcpServers([cfg]);
    const s = statuses.find((x) => x.id === 'real');
    check('(a/e2e) real spawned stdio server connected', s?.state === 'connected');
    check('(a/e2e) real server exposed its 2 tools (echo + boom)', s?.toolCount === 2);

    const echo = listMcpTools().find((t) => t.name === 'real__echo');
    check('(a/e2e) real server tool is namespaced + listed', !!echo);
    check('(a/e2e) real server tool is gated', echo?.gated === true);

    // Call the wrapped tool through the registry's callMcpTool — the SAME entry
    // point the loop uses — so this drives a true MCP callTool over stdio.
    const out = await callMcpTool('real__echo', { text: 'wire' }, ctx);
    check('(b/e2e) real callTool round-trips the echo result', out.text.includes('echo: wire'));
    const errOut = await callMcpTool('real__boom', {}, ctx);
    check('(b/e2e) real callTool maps an isError result', errOut.isError === true);

    // (c/e2e) a real bogus command fails gracefully alongside the good one.
    const withBogus = await syncExternalMcpServers([
      cfg,
      { id: 'bogus', command: 'definitely-not-a-real-binary-xyz', args: [], enabled: true },
    ]);
    const bogus = withBogus.find((x) => x.id === 'bogus');
    check('(c/e2e) a real un-spawnable command is marked error', bogus?.state === 'error');
    check('(c/e2e) the good server stayed connected despite the bad one', withBogus.find((x) => x.id === 'real')?.state === 'connected');

    await disposeExternalMcpServers();
    check(
      '(d) dispose removed every external tool from the model list',
      !listMcpTools().some((t) => t.name.startsWith('real__') || t.name.startsWith('bogus__')),
    );
  }

  /* ── end-to-end: REAL StreamableHTTPClientTransport against an in-proc server ─ */
  {
    const mock = await startHttpMockServer();
    try {
      const cfg: McpServerConfig = {
        id: 'web',
        transport: 'http',
        url: mock.url,
        enabled: true,
      };
      const statuses = await syncExternalMcpServers([cfg]);
      const s = statuses.find((x) => x.id === 'web');
      check('(a/http) real remote HTTP server connected', s?.state === 'connected');
      check('(a/http) status reports http transport', s?.transport === 'http');
      check('(a/http) remote server exposed its 2 tools', s?.toolCount === 2);

      // Drive a true MCP callTool over Streamable HTTP via the loop's entry point.
      const out = await callMcpTool('web__echo', { text: 'http-wire' }, ctx);
      check('(b/http) remote callTool round-trips the echo result', out.text.includes('echo: http-wire'));
      const errOut = await callMcpTool('web__boom', {}, ctx);
      check('(b/http) remote callTool maps an isError result', errOut.isError === true);

      await disposeExternalMcpServers();
      check(
        '(d/http) dispose removed the remote server tools',
        !listMcpTools().some((t) => t.name.startsWith('web__')),
      );
    } finally {
      await mock.close();
    }
  }

  /* ── capability bridge: prompts/resources surfaced as namespaced meta-tools ── */
  {
    const client = makeRichMockClient();
    const cfg: McpServerConfig = { id: 'cap', command: 'noop', enabled: true };
    await syncExternalMcpServers([cfg], async () => ({ client }));
    const names = listMcpTools().map((t) => t.name);
    check('caps: list_prompts meta-tool synthesized', names.includes('cap__list_prompts'));
    check('caps: get_prompt meta-tool synthesized', names.includes('cap__get_prompt'));
    check('caps: list_resources meta-tool synthesized', names.includes('cap__list_resources'));
    check('caps: read_resource meta-tool synthesized', names.includes('cap__read_resource'));
    check('caps: the real tool is still present alongside the meta-tools', names.includes('cap__echo'));
    check('caps: read-only meta-tools are NOT write (callable in read-only)', !isWriteTool('cap__read_resource') && !isWriteTool('cap__list_prompts'));

    const lp = await callMcpTool('cap__list_prompts', {}, ctx);
    check('caps: list_prompts enumerates the prompt + required arg', lp.text.includes('greet') && lp.text.includes('who*'));
    const gp = await callMcpTool('cap__get_prompt', { name: 'greet', arguments: { who: 'sam' } }, ctx);
    check('caps: get_prompt expands the template into role-tagged messages', gp.text.includes('[user]') && gp.text.includes('hi sam'));
    const gpMissing = await callMcpTool('cap__get_prompt', {}, ctx);
    check('caps: get_prompt without a name returns a tool error', gpMissing.isError === true);
    const lr = await callMcpTool('cap__list_resources', {}, ctx);
    check('caps: list_resources enumerates uri + mime', lr.text.includes('mem://note') && lr.text.includes('text/plain'));
    const rr = await callMcpTool('cap__read_resource', { uri: 'mem://note' }, ctx);
    check('caps: read_resource returns the resource body under its uri', rr.text.includes('[resource mem://note]') && rr.text.includes('resource body'));

    await syncExternalMcpServers([], async () => ({ client }));
    check('caps: dispose removes the synthesized meta-tools', !listMcpTools().some((t) => t.name.startsWith('cap__')));
  }

  /* ── capability policy: synthesized tools honor disabled/confirm/auto rules ─ */
  {
    const client = makeRichMockClient();
    await syncExternalMcpServers([
      {
        id: 'cap_hidden',
        command: 'noop',
        enabled: true,
        disabledTools: ['list_resources', 'read_resource'],
      },
    ], async () => ({ client }));
    const names = listMcpTools().map((t) => t.name);
    check('caps policy: disabledTools hides synthesized list_resources', !names.includes('cap_hidden__list_resources'));
    check('caps policy: disabledTools hides synthesized read_resource', !names.includes('cap_hidden__read_resource'));
    await syncExternalMcpServers([], async () => ({ client }));

    await syncExternalMcpServers([
      {
        id: 'cap_confirm',
        command: 'noop',
        enabled: true,
        trust: true,
        confirmTools: ['read_resource'],
      },
    ], async () => ({ client }));
    const confirmRead = listMcpTools().find((t) => t.name === 'cap_confirm__read_resource');
    check('caps policy: confirmTools keeps synthesized read_resource gated on a trusted server', confirmRead?.gated === true);
    await syncExternalMcpServers([], async () => ({ client }));

    await syncExternalMcpServers([
      {
        id: 'cap_deny_wins',
        command: 'noop',
        enabled: true,
        autoApproveTools: ['read_resource'],
        confirmTools: ['read_resource'],
      },
    ], async () => ({ client }));
    const denyWins = listMcpTools().find((t) => t.name === 'cap_deny_wins__read_resource');
    check('caps policy: confirmTools beats autoApprove for synthesized read_resource', denyWins?.gated === true);
    await syncExternalMcpServers([], async () => ({ client }));

    const largeClient = makeRichMockClient({
      prompts: [{ name: 'huge', description: makeLargeCapabilityText('prompt') }],
      resources: [{ uri: 'mem://huge', name: makeLargeCapabilityText('resource'), mimeType: 'text/plain' }],
    });
    await syncExternalMcpServers([{ id: 'cap_big', command: 'noop', enabled: true }], async () => ({ client: largeClient }));
    const lp = await callMcpTool('cap_big__list_prompts', {}, ctx);
    check('caps policy: list_prompts scrubs token-shaped secrets', !lp.text.includes('sk-ant-1234567890abcdefghijklmnop') && lp.text.includes('«redacted»'));
    check('caps policy: list_prompts clips oversized output', lp.text.includes('clipped') && !lp.text.includes('sentinel-after-limit'));
    const lr = await callMcpTool('cap_big__list_resources', {}, ctx);
    check('caps policy: list_resources scrubs token-shaped secrets', !lr.text.includes('sk-ant-1234567890abcdefghijklmnop') && lr.text.includes('«redacted»'));
    check('caps policy: list_resources clips oversized output', lr.text.includes('clipped') && !lr.text.includes('sentinel-after-limit'));
    await syncExternalMcpServers([], async () => ({ client: largeClient }));
  }

  /* ── tool hygiene: invalid external tool names are filtered out ───────────── */
  {
    const overlongTool = 'x'.repeat(MAX_MCP_MODEL_TOOL_NAME + 1);
    const client = makeRichMockClient({
      tools: [
        { name: 'echo', description: 'Echo.', inputSchema: { type: 'object', properties: {} } },
        { name: 'valid_tool-2', description: 'Valid.', inputSchema: { type: 'object', properties: {} } },
        { name: 'bad name', description: 'Invalid.', inputSchema: { type: 'object', properties: {} } },
        { name: 'bad/slash', description: 'Invalid.', inputSchema: { type: 'object', properties: {} } },
        { name: 'bad.dot', description: 'Invalid.', inputSchema: { type: 'object', properties: {} } },
        { name: overlongTool, description: 'Invalid.', inputSchema: { type: 'object', properties: {} } },
        { name: undefined, description: 'Invalid.', inputSchema: { type: 'object', properties: {} } },
        { name: null, description: 'Invalid.', inputSchema: { type: 'object', properties: {} } },
        { description: 'Invalid.', inputSchema: { type: 'object', properties: {} } },
      ],
    });
    await syncExternalMcpServers([{ id: 'tool_names', command: 'noop', enabled: true }], async () => ({ client }));
    const names = listMcpTools().map((t) => t.name);
    check('tool hygiene: valid external tools stay exposed', names.includes('tool_names__echo') && names.includes('tool_names__valid_tool-2'));
    check('tool hygiene: invalid external tool names are filtered out', !names.includes('tool_names__bad name') && !names.includes('tool_names__bad/slash') && !names.includes('tool_names__bad.dot'));
    check('tool hygiene: overlong bare tool names are filtered out', !names.includes(`tool_names__${overlongTool}`));
    check('tool hygiene: malformed non-string tool names are ignored', !names.includes('tool_names__undefined') && !names.includes('tool_names__null') && !names.includes('tool_names__'));
    await syncExternalMcpServers([], async () => ({ client }));

    const boundarySecret = `prefix ${'a'.repeat(973)} sk-ant-1234567890abcdefghijklmnop`;
    const boundaryClient = makeRichMockClient({
      tools: [
        {
          name: 'echo',
          description: boundarySecret,
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });
    await syncExternalMcpServers([{ id: 'tool_boundary', command: 'noop', enabled: true }], async () => ({ client: boundaryClient }));
    const boundaryTool = listMcpTools().find((t) => t.name === 'tool_boundary__echo');
    check('tool hygiene: boundary-crossing secret is scrubbed before metadata clipping', boundaryTool !== undefined && !boundaryTool.description.includes('sk-ant-') && boundaryTool.description.includes('redacted'));
    await syncExternalMcpServers([], async () => ({ client: boundaryClient }));

    const longId = 's'.repeat(MAX_MCP_MODEL_TOOL_NAME - 1);
    const namespaceClient = makeRichMockClient({
      tools: [{ name: 'tiny', description: 'Tiny.', inputSchema: { type: 'object', properties: {} } }],
    });
    await syncExternalMcpServers([{ id: longId, command: 'noop', enabled: true }], async () => ({ client: namespaceClient }));
    check('tool hygiene: overlong final namespaced tool names are filtered out', !listMcpTools().some((t) => t.name === `${longId}__tiny`));
    await syncExternalMcpServers([], async () => ({ client: namespaceClient }));
  }

  /* ── metadata hygiene: external tool metadata is scrubbed and clipped ─────── */
  {
    const secret = 'sk-ant-1234567890abcdefghijklmnop';
    const large = `${secret} ${'0123456789'.repeat(220)} sentinel-after-limit`;
    const overlongKey = 'p'.repeat(MAX_MCP_MODEL_TOOL_NAME + 1);
    const { client } = makeMockClient();
    const server = buildExternalServer('metadata', client, [
      {
        name: 'echo',
        title: `Title ${large}`,
        description: `Description ${large}`,
        inputSchema: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: `Param ${large}`,
              [secret]: 'leaked-key',
              [overlongKey]: 'long-key',
            },
            [secret]: { type: 'string', description: 'secret key' },
            [overlongKey]: { type: 'string', description: 'long key' },
          },
          required: ['text', secret, overlongKey],
        },
      },
    ]);
    const tool = server.tools[0];
    check('metadata hygiene: tool description scrubs token-shaped secrets', !tool.description.includes(secret) && tool.description.includes('redacted'));
    check('metadata hygiene: tool description clips oversized metadata', tool.description.includes('clipped') && !tool.description.includes('sentinel-after-limit'));
    const schema = tool.inputSchema as { properties?: Record<string, { description?: string }> };
    const schemaKeys = Object.keys(schema.properties ?? {});
    const fieldSchema = schema.properties?.text as Record<string, unknown> | undefined;
    const fieldDescription = typeof fieldSchema?.description === 'string' ? fieldSchema.description : '';
    check('metadata hygiene: schema descriptions scrub token-shaped secrets', !fieldDescription.includes(secret) && fieldDescription.includes('redacted'));
    check('metadata hygiene: schema descriptions clip oversized metadata', fieldDescription.includes('clipped') && !fieldDescription.includes('sentinel-after-limit'));
    check('metadata hygiene: unsafe schema property names are dropped', !schemaKeys.includes(secret) && !schemaKeys.includes(overlongKey));
    check('metadata hygiene: unsafe nested schema keys are dropped', fieldSchema !== undefined && !Object.keys(fieldSchema).includes(secret) && !Object.keys(fieldSchema).includes(overlongKey));
  }

  /* ── error hygiene: thrown MCP errors are scrubbed and clipped ───────────── */
  {
    const largeError = makeLargeCapabilityText('error');
    const throwingClient: McpClientLike = {
      async listTools() {
        return { tools: [] };
      },
      async callTool() {
        throw new Error(largeError);
      },
      async close() {},
    };
    const server = buildExternalServer('err_tool', throwingClient, [
      { name: 'explode', description: 'Throws.', inputSchema: { type: 'object', properties: {} } },
    ]);
    const tool = server.tools.find((entry) => entry.name === 'err_tool__explode');
    const toolError = tool ? await tool.exec({}, ctx) : { text: '', isError: false };
    check('error hygiene: thrown tool errors scrub token-shaped secrets', toolError.isError === true && !toolError.text.includes('sk-ant-1234567890abcdefghijklmnop') && toolError.text.includes('redacted'));
    check('error hygiene: thrown tool errors are clipped', toolError.text.includes('clipped') && !toolError.text.includes('sentinel-after-limit'));

    const capabilityClient: McpClientLike = {
      async listTools() {
        return { tools: [] };
      },
      async callTool() {
        return { content: [{ type: 'text', text: 'ok' }] };
      },
      async close() {},
      getServerCapabilities() {
        return { prompts: {} };
      },
      async listPrompts() {
        throw new Error(largeError);
      },
      async getPrompt() {
        return { messages: [] };
      },
    };
    const capTool = buildCapabilityTools('err_cap', capabilityClient, {}, new Set())
      .find((entry) => entry.name === 'err_cap__list_prompts');
    const capError = capTool ? await capTool.exec({}, ctx) : { text: '', isError: false };
    check('error hygiene: capability errors scrub token-shaped secrets', capError.isError === true && !capError.text.includes('sk-ant-1234567890abcdefghijklmnop') && capError.text.includes('redacted'));
    check('error hygiene: capability errors are clipped', capError.text.includes('clipped') && !capError.text.includes('sentinel-after-limit'));
  }

  /* ── capability guard: a tools-only server gets no synthesized meta-tools ──── */
  {
    const { client } = makeMockClient(); // no getServerCapabilities
    await syncExternalMcpServers([{ id: 'plain', command: 'noop', enabled: true }], async () => ({ client }));
    const names = listMcpTools().map((t) => t.name);
    check('caps: a tools-only server exposes no list_prompts/list_resources', !names.includes('plain__list_prompts') && !names.includes('plain__list_resources'));
    await syncExternalMcpServers([], async () => ({ client }));
  }

  /* ── health: an unexpected drop reconnects via backoff (injected scheduler) ── */
  {
    const queue: (() => Promise<void>)[] = [];
    setReconnectSchedulerForTests((run) => {
      queue.push(run);
      return queue.length;
    });
    const flush = async (): Promise<void> => {
      let guard = 0;
      while (queue.length > 0 && guard < 50) {
        guard += 1;
        await queue.shift()!();
      }
    };

    let current = makeMockClient().client;
    const connect = async (): Promise<{ client: McpClientLike }> => {
      current = makeMockClient().client;
      return { client: current };
    };
    const cfg: McpServerConfig = { id: 'rc', command: 'noop', enabled: true };
    await syncExternalMcpServers([cfg], connect);
    check('reconnect: server is connected with tools before the drop', listMcpTools().some((t) => t.name === 'rc__echo'));

    // Simulate the transport dropping unexpectedly.
    current.onclose?.();
    const dropped = listMcpServerStatuses().find((x) => x.id === 'rc');
    check('reconnect: an unexpected drop marks the server "reconnecting"', dropped?.state === 'reconnecting');
    check('reconnect: the dropped server\'s tools are removed while down', !listMcpTools().some((t) => t.name === 'rc__echo'));

    await flush(); // run the scheduled backoff attempt
    const recovered = listMcpServerStatuses().find((x) => x.id === 'rc');
    check('reconnect: a backoff retry restores the connection', recovered?.state === 'connected');
    check('reconnect: the tools are back after reconnect', listMcpTools().some((t) => t.name === 'rc__echo'));

    await syncExternalMcpServers([], connect); // cleanup
    setReconnectSchedulerForTests(null);
  }

  /* ── health: reconnect gives up + errors after the max attempts ──────────── */
  {
    const queue: (() => Promise<void>)[] = [];
    setReconnectSchedulerForTests((run) => {
      queue.push(run);
    });
    const flush = async (): Promise<void> => {
      let guard = 0;
      while (queue.length > 0 && guard < 50) {
        guard += 1;
        await queue.shift()!();
      }
    };

    let first: McpClientLike | null = null;
    const okThenFail = async (): Promise<{ client: McpClientLike }> => {
      if (!first) {
        first = makeMockClient().client;
        return { client: first };
      }
      throw new Error('still down');
    };
    const cfg: McpServerConfig = { id: 'rcf', command: 'noop', enabled: true };
    await syncExternalMcpServers([cfg], okThenFail);
    first!.onclose?.(); // drop → begins reconnect attempts that all fail
    await flush();
    const gaveUp = listMcpServerStatuses().find((x) => x.id === 'rcf');
    check('reconnect: gives up and marks "error" after exhausting retries', gaveUp?.state === 'error');
    check('reconnect: no tools remain after giving up', !listMcpTools().some((t) => t.name === 'rcf__echo'));

    await syncExternalMcpServers([], okThenFail); // cleanup
    setReconnectSchedulerForTests(null);
  }

  /* ── health: disabling a reconnecting server cancels its backoff ─────────── */
  {
    const queue: (() => Promise<void>)[] = [];
    setReconnectSchedulerForTests((run) => {
      queue.push(run);
    });
    let current = makeMockClient().client;
    const connect = async (): Promise<{ client: McpClientLike }> => {
      current = makeMockClient().client;
      return { client: current };
    };
    const cfg: McpServerConfig = { id: 'rcd', command: 'noop', enabled: true };
    await syncExternalMcpServers([cfg], connect);
    current.onclose?.(); // → reconnecting (a backoff attempt is queued)
    check('reconnect: a backoff attempt was scheduled', queue.length === 1);
    // Disable the server while it's mid-reconnect.
    const after = await syncExternalMcpServers([{ ...cfg, enabled: false }], connect);
    const s = after.find((x) => x.id === 'rcd');
    check('reconnect: disabling a reconnecting server reports "disabled"', s?.state === 'disabled');
    // The previously-queued attempt must be a no-op now (its entry was cancelled).
    await queue.shift()?.();
    check('reconnect: the cancelled backoff attempt did not reconnect', !listMcpTools().some((t) => t.name === 'rcd__echo'));

    await syncExternalMcpServers([], connect); // cleanup
    setReconnectSchedulerForTests(null);
  }

  /* ── live refresh: notifications/tools/list_changed re-discovers tools ─────── */
  {
    let toolset: McpExternalToolInfo[] = [
      { name: 'echo', inputSchema: { type: 'object', properties: {} } },
    ];
    const handlers: (() => void | Promise<void>)[] = [];
    const client: McpClientLike = {
      async listTools() {
        return { tools: toolset };
      },
      async callTool() {
        return { content: [{ type: 'text', text: 'ok' }] };
      },
      async close() {},
      setNotificationHandler(_schema, handler) {
        handlers.push(handler);
      },
    };
    const cfg: McpServerConfig = { id: 'lc', command: 'noop', enabled: true };
    await syncExternalMcpServers([cfg], async () => ({ client }));
    check('list_changed: subscribed to the server notifications', handlers.length >= 1);
    check('list_changed: initial tool present', listMcpTools().some((t) => t.name === 'lc__echo'));
    check('list_changed: a not-yet-added tool is absent', !listMcpTools().some((t) => t.name === 'lc__added'));

    // Server adds a tool, then announces the change.
    toolset = [
      { name: 'echo', inputSchema: { type: 'object', properties: {} } },
      { name: 'added', inputSchema: { type: 'object', properties: {} } },
    ];
    await handlers[0]!();
    check('list_changed: a newly-added tool appears after the notification', listMcpTools().some((t) => t.name === 'lc__added'));
    const lcStatus = listMcpServerStatuses().find((x) => x.id === 'lc');
    check('list_changed: status tool count reflects the refresh', lcStatus?.toolCount === 2);

    // Server removes all tools, announces again.
    toolset = [];
    await handlers[0]!();
    check('list_changed: removed tools disappear after the notification', !listMcpTools().some((t) => t.name.startsWith('lc__')));

    await syncExternalMcpServers([], async () => ({ client }));
  }

  /* ── fetch_url: SSRF guard + HTML→text + content-type handling ─────────────── */
  {
    check('fetch_url: localhost is a blocked host', isBlockedHost('localhost'));
    check('fetch_url: 127.0.0.1 is blocked', isBlockedHost('127.0.0.1'));
    check('fetch_url: 10.x private is blocked', isBlockedHost('10.1.2.3'));
    check('fetch_url: 192.168.x private is blocked', isBlockedHost('192.168.0.5'));
    check('fetch_url: 169.254.x link-local is blocked', isBlockedHost('169.254.1.1'));
    check('fetch_url: a public host is allowed', !isBlockedHost('example.com'));
    check('fetch_url: htmlToText strips tags + keeps title', (() => {
      const out = htmlToText('<html><head><title>Doc</title></head><body><script>x()</script><h1>Hi</h1><p>Body text.</p></body></html>');
      return out.includes('Doc') && out.includes('Hi') && out.includes('Body text.') && !out.includes('x()') && !out.includes('<');
    })());

    setFetchUrlTransportForTests(async (url) => ({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<html><title>Example</title><body><p>Hello from ${url.hostname}.</p></body></html>`,
      finalUrl: url.href,
    }));
    const htmlOut = await callMcpTool('fetch_url', { url: 'https://example.com/page' }, ctx);
    check('fetch_url: returns readable text from an HTML page', htmlOut.text.includes('Example') && htmlOut.text.includes('Hello from example.com'));
    check('fetch_url: HTML tags are not present in the output', !htmlOut.text.includes('<p>'));

    setFetchUrlTransportForTests(async (url) => ({
      status: 200,
      contentType: 'text/plain',
      body: 'plain body line',
      finalUrl: url.href,
    }));
    const textOut = await callMcpTool('fetch_url', { url: 'https://example.com/raw.txt' }, ctx);
    check('fetch_url: passes text/plain through verbatim', textOut.text.includes('plain body line'));

    // The SSRF guard refuses before any transport runs.
    let transportCalled = false;
    setFetchUrlTransportForTests(async (url) => {
      transportCalled = true;
      return { status: 200, contentType: 'text/plain', body: 'secret', finalUrl: url.href };
    });
    const blockedOut = await callMcpTool('fetch_url', { url: 'http://localhost:8080/admin' }, ctx);
    check('fetch_url: a loopback URL is refused', blockedOut.isError === true && !transportCalled);
    const schemeOut = await callMcpTool('fetch_url', { url: 'file:///etc/passwd' }, ctx);
    check('fetch_url: a non-http(s) scheme is refused', schemeOut.isError === true);

    setFetchUrlTransportForTests(null);
  }

  /* ── web_search: HTML results fallback when Instant Answer is empty ────────── */
  {
    // IA returns nothing (the common case for ordinary queries).
    setWebSearchTransportForTests(async () => ({ RelatedTopics: [] }));
    let htmlQueried = '';
    setWebSearchHtmlTransportForTests(async (url) => {
      htmlQueried = url.searchParams.get('q') ?? '';
      return `
        <div class="result">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fwiki">Example Wiki</a>
          <a class="result__snippet">A snippet about the example wiki.</a>
        </div>`;
    });
    const out = await callMcpTool('web_search', { query: 'some ordinary query' }, ctx);
    check('web_search: falls back to the HTML endpoint when IA is empty', htmlQueried === 'some ordinary query');
    check('web_search: HTML fallback decodes the real target URL', out.text.includes('https://example.org/wiki'));
    check('web_search: HTML fallback surfaces the title + snippet', out.text.includes('Example Wiki') && out.text.includes('example wiki'));
    setWebSearchTransportForTests(null);
    setWebSearchHtmlTransportForTests(null);
  }

  /* ── MCP-1 Case A: stable tool-name sort (order-independent of connect order) ── */
  {
    // Register two servers whose ids sort z > a, but connect z FIRST so it would land
    // earlier in registration (flatMap) order. A stable name sort must place a_* before
    // z_* regardless. The fixed built-in tail (ask_user, spawn_*) must stay at the end.
    const { client: zClient } = makeMockClient();
    const { client: aClient } = makeMockClient();
    await syncExternalMcpServers([{ id: 'z_server', command: 'noop', enabled: true }], async () => ({ client: zClient }));
    await syncExternalMcpServers(
      [
        { id: 'z_server', command: 'noop', enabled: true },
        { id: 'a_server', command: 'noop', enabled: true },
      ],
      async (c) => ({ client: c.id === 'a_server' ? aClient : zClient }),
    );
    const names = listMcpTools().map((t) => t.name);
    const dynamic = names.filter((n) => n.startsWith('a_server__') || n.startsWith('z_server__'));
    const sortedDynamic = [...dynamic].sort();
    check('sort: dynamic MCP tools are alphabetical regardless of connect order', JSON.stringify(dynamic) === JSON.stringify(sortedDynamic));
    check('sort: a_server tools precede z_server tools', names.indexOf('a_server__echo') < names.indexOf('z_server__echo'));
    check('sort: ask_user stays in the fixed built-in tail (last)', names[names.length - 1] === 'ask_user');
    check('sort: spawn_subagent is in the fixed tail (after the sorted dynamic tools)', names.indexOf('spawn_subagent') > names.indexOf('z_server__echo'));
    // A second sync of the SAME set yields byte-identical ordering (cache-stable).
    const namesAgain = listMcpTools().map((t) => t.name);
    check('sort: repeated listMcpTools is order-stable', JSON.stringify(names) === JSON.stringify(namesAgain));
    await syncExternalMcpServers([], async () => ({ client: zClient }));
  }

  /* ── MCP-1 Case C: pending-connect dedup (concurrent connects share one client) ── */
  {
    let connectCalls = 0;
    let release = (): void => {};
    const { client } = makeMockClient();
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connect = async (): Promise<{ client: McpClientLike }> => {
      connectCalls += 1;
      await gate; // hold both callers in the same in-flight connect
      return { client };
    };
    const cfg: McpServerConfig = { id: 'dedup', command: 'noop', enabled: true };
    // Two concurrent connect calls for the same id — must share ONE connection.
    const p1 = connectServer(cfg, connect);
    const p2 = connectServer(cfg, connect);
    check('dedup: a concurrent connect returns the same in-flight promise', p1 === p2);
    release();
    const [s1, s2] = await Promise.all([p1, p2]);
    check('dedup: the connector factory ran exactly once for concurrent calls', connectCalls === 1);
    check('dedup: both callers see the connected status', s1.state === 'connected' && s2.state === 'connected');
    check('dedup: the shared server registered its tools once', listMcpTools().filter((t) => t.name === 'dedup__echo').length === 1);
    // After it settles, a fresh connect runs the factory again (pending map cleared).
    await connectServer(cfg, connect);
    check('dedup: a later connect runs the factory again (pending cleared)', connectCalls === 2);
    await syncExternalMcpServers([], connect);
  }

  /* ── MCP-1 Case B: deferred tools on reconnect + abort-aware exec ──────────────── */
  {
    // Capture (don't auto-run) backoff retries so we control the reconnect timing.
    const queue: (() => Promise<void>)[] = [];
    setReconnectSchedulerForTests((run) => {
      queue.push(run);
    });

    // 1) Connect normally so lastKnownTools is seeded with [echo, boom].
    const { client: first } = makeMockClient();
    const cfg: McpServerConfig = { id: 'defer', command: 'noop', enabled: true };
    await syncExternalMcpServers([cfg], async () => ({ client: first }));
    check('defer: server connected and tools seeded', listMcpTools().some((t) => t.name === 'defer__echo'));

    // 2) Drop the transport — schedules a backoff reconnect (captured, not yet run).
    first.onclose?.();
    check('defer: a backoff reconnect was scheduled after the drop', queue.length === 1);

    // 3) Run the reconnect, but hold the connect open so the server stays "connecting".
    //    The deferred tools (from lastKnownTools) must be exposed immediately.
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { client: second, calls: secondCalls } = makeMockClient();
    setReconnectSchedulerForTests((run) => {
      queue.push(run);
    });
    // Swap the connector the reconnect uses by re-driving connectServer with a slow connect.
    const slowConnect = async (): Promise<{ client: McpClientLike }> => {
      await gate;
      return { client: second };
    };
    const reconnectPromise = connectServer(cfg, slowConnect);
    check('defer: deferred tools are exposed immediately while (re)connecting', listMcpTools().some((t) => t.name === 'defer__echo'));

    // 4) A deferred tool call issued WHILE connecting must wait, then route to the real client.
    const liveCtx: ToolContext = { ws: null, signal: new AbortController().signal };
    const deferredTool = listMcpTools().find((t) => t.name === 'defer__echo');
    const execPromise = deferredTool && 'exec' in deferredTool && typeof deferredTool.exec === 'function'
      ? deferredTool.exec({ text: 'deferred' }, liveCtx)
      : Promise.resolve({ summary: '', text: '', isError: true } as ToolResult);
    // Let the connect settle; the queued deferred call then routes to the real client.
    release();
    await reconnectPromise;
    const deferredOut = await execPromise;
    check('defer: a deferred call routes to the reconnected client', secondCalls.some((c) => c.name === 'echo'));
    check('defer: the deferred call returns the real result', deferredOut.text.includes('echo: deferred'));

    // 5) Abort mid-wait: drop again, start a slow reconnect, call a deferred tool with an
    //    already-aborting signal — it must reject fast with an error ToolResult, not hang.
    second.onclose?.();
    const gate2 = new Promise<void>(() => {}); // never resolves — server stays connecting
    const stalledConnect = async (): Promise<{ client: McpClientLike }> => {
      await gate2;
      return { client: second };
    };
    const stalledPromise = connectServer(cfg, stalledConnect);
    const abortController = new AbortController();
    const abortCtx: ToolContext = { ws: null, signal: abortController.signal };
    const stalledTool = listMcpTools().find((t) => t.name === 'defer__echo');
    const abortExec = stalledTool && 'exec' in stalledTool && typeof stalledTool.exec === 'function'
      ? stalledTool.exec({ text: 'x' }, abortCtx)
      : Promise.resolve({ summary: '', text: '', isError: false } as ToolResult);
    abortController.abort(); // turn cancelled while the deferred tool waits
    const abortOut = await abortExec;
    check('defer: a deferred call aborted mid-wait returns an error ToolResult', abortOut.isError === true);
    check('defer: the abort error names the waiting cause', abortOut.text.includes('aborted'));

    // 6) before-quit teardown must not hang on the still-stalled connect / waiters.
    await disposeExternalMcpServers();
    check('defer: dispose removed the deferred server tools', !listMcpTools().some((t) => t.name.startsWith('defer__')));
    // Let the never-resolving connect settle into a no-op (its registration was already torn down).
    void stalledPromise.catch(() => {});
    setReconnectSchedulerForTests(null);
  }

  console.log(`\nexternal-mcp harness: ${passedCount()} assertions passed`);
}

main()
  .then(() => disposeExternalMcpServers())
  .catch(async (err) => {
    console.error('external-mcp harness FAILED:', err);
    await disposeExternalMcpServers().catch(() => {});
    process.exitCode = 1;
  });
