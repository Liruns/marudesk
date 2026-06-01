import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * A TINY in-repo MCP stdio server for the headless harness (mcp-harness.ts). It
 * speaks the real MCP stdio protocol — spawned by the harness through the genuine
 * `StdioClientTransport` — and exposes ONE `echo` tool plus a `boom` tool that
 * returns an error result, so the harness can assert end-to-end spawning, tool
 * discovery, the `client.callTool` round-trip, and `isError` mapping.
 *
 * Only SDK imports (no relative ones), so it runs under `node
 * --experimental-strip-types` without the harness's `.ts` resolve hook.
 */

const server = new Server(
  { name: 'mock-echo', version: '0.0.1' },
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

const transport = new StdioServerTransport();
await server.connect(transport);
