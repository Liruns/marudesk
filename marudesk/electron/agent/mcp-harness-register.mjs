import { register } from 'node:module';

/**
 * Registers the MCP harness's resolve hook (./mcp-harness-loader.mjs) before the
 * harness entry runs. Used only via the `harness:mcp` npm script — see
 * ./mcp-harness-loader.mjs for what it does.
 */
register('./mcp-harness-loader.mjs', import.meta.url);
