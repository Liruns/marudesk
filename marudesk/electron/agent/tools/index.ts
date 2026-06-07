/**
 * The agent tool layer, split for clarity (docs/architecture-review-2026-06.md):
 *   - types.ts     — shapes + tool-name constant sets (no runtime deps)
 *   - executors.ts — the concrete executors + executeTool + describeToolInput
 *   - schemas.ts   — the JSON-Schema list the model reads
 *   - registry.ts  — the MCP descriptor layer (schema + executor + metadata)
 *
 * This barrel preserves the original `./tools` import surface, so consumers are
 * unchanged.
 */
export type {
  ToolSchema,
  ToolContext,
  ToolResult,
  Executor,
  McpGroup,
  McpToolDef,
  McpTool,
} from './types';
export {
  GATED_TOOLS,
  ASK_USER,
  SPAWN_SUBAGENT,
  SPAWN_BACKGROUND_AGENT,
  COLLECT_BACKGROUND_AGENT,
  CANCEL_BACKGROUND_AGENT,
  UPDATE_PLAN,
} from './types';
export { executeTool, describeToolInput } from './executors';
export { TOOL_SCHEMAS } from './schemas';
export {
  BUILTIN_TOOLS,
  ASK_USER_DEF,
  SPAWN_SUBAGENT_DEF,
  SPAWN_BACKGROUND_AGENT_DEF,
  COLLECT_BACKGROUND_AGENT_DEF,
  CANCEL_BACKGROUND_AGENT_DEF,
  UPDATE_PLAN_DEF,
} from './registry';
