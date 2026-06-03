import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mcpDisplayTarget,
  mcpTransportOf,
  sanitizeMcpConfig,
  type McpServerConfig,
} from '../../shared/mcp';
import { callMcpTool, listMcpTools } from './mcp';
import type { ToolContext } from './tools';
import {
  buildExternalServer,
  connectServer,
  disposeExternalMcpServers,
  listMcpServerStatuses,
  syncExternalMcpServers,
  toToolResult,
  type McpCallToolResult,
  type McpClientLike,
  type McpExternalToolInfo,
} from './mcp-external';
import { startHttpMockServer } from './mcp-mock-http-server';

/**
 * Headless harness for the external MCP connector
 * (docs/remote-mobile-bridge-design §M3, docs/context-mcp-design §8). Mirrors
 * electron/server/harness.ts (run with `node --experimental-strip-types`, see
 * package.json `harness:mcp`); a small resolve hook stubs the bare `electron` import
 * and adds `.ts` resolution so the agent module chain loads without Electron.
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

let passed = 0;
function check(label: string, cond: boolean): void {
  assert.ok(cond, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

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
        // sse transport with trust + disabledTools.
        { id: 'sse1', transport: 'sse', url: 'http://localhost:9000/sse', trust: true, disabledTools: ['danger', '  '] },
        // invalid: http transport but a non-http url → dropped.
        { id: 'bad-url', transport: 'http', url: 'ftp://nope' },
        // invalid: neither command nor url → dropped.
        { id: 'empty', enabled: true },
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
    check('sanitize: non-http url for http transport is dropped', !byId.has('bad-url'));
    check('sanitize: entry with neither command nor url is dropped', !byId.has('empty'));
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
    const { client } = makeMockClient();
    const cfg: McpServerConfig = { id: 'crashy', command: 'noop', enabled: true };
    await syncExternalMcpServers([cfg], async () => ({ client }));
    check('crash: tool is live before the drop', listMcpTools().some((t) => t.name === 'crashy__echo'));
    // Simulate the transport dropping (process exit / network loss).
    check('crash: connectServer wired an onclose handler', typeof client.onclose === 'function');
    client.onclose?.();
    const s = listMcpServerStatuses().find((x) => x.id === 'crashy');
    check('crash: the server is marked error after the drop', s?.state === 'error');
    check('crash: its tools are removed from the model list', !listMcpTools().some((t) => t.name === 'crashy__echo'));
    await syncExternalMcpServers([], async () => ({ client }));
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
    check('built-in ask_user is still listed', listed.includes('ask_user'));

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

  /* ── graceful failure: a server that fails to spawn (injected throw) ─────── */
  {
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

  console.log(`\nexternal-mcp harness: ${passed} assertions passed`);
}

main()
  .then(() => disposeExternalMcpServers())
  .catch(async (err) => {
    console.error('external-mcp harness FAILED:', err);
    await disposeExternalMcpServers().catch(() => {});
    process.exitCode = 1;
  });
