import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * An in-process HTTP MCP server for the headless harness (mcp-harness.ts) — the
 * remote-transport counterpart to mcp-mock-server.ts (stdio). It exposes the SAME
 * `echo` + `boom` tools over **Streamable HTTP** so the harness can assert a real
 * `StreamableHTTPClientTransport` round-trip end to end: connect → initialize →
 * listTools → callTool, plus `isError` mapping.
 *
 * Stateless JSON mode (the SDK's recommended pattern for a simple server): a fresh
 * Server + transport per request, `sessionIdGenerator: undefined`,
 * `enableJsonResponse: true` so each POST gets a single JSON response (no long-lived
 * SSE stream to coordinate in a test).
 */

function buildServer(): Server {
  const server = new Server(
    { name: 'mock-echo-http', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: 'echo',
        description: 'Echo the provided text back.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string', description: 'Text to echo.' } },
          required: ['text'],
        },
      },
      {
        name: 'boom',
        description: 'Always returns a tool error (for testing isError mapping).',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, (req) => {
    const { name, arguments: args } = req.params;
    if (name === 'echo') {
      const text = typeof args?.text === 'string' ? args.text : '';
      return { content: [{ type: 'text', text: `echo: ${text}` }] };
    }
    if (name === 'boom') {
      return { content: [{ type: 'text', text: 'kaboom' }], isError: true };
    }
    return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
  });
  return server;
}

/** Start the mock HTTP MCP server on an ephemeral port; resolves its URL + a closer. */
export async function startHttpMockServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const http: HttpServer = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : undefined;

      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}
