import type { McpTool, ToolResult } from './types';

/**
 * `create_artifact` (v6 §G4/U6) — render a self-contained interactive HTML
 * artifact inline in the chat. The HTML is shipped to the renderer and drawn in a
 * SANDBOXED, network-isolated iframe (opaque origin + strict CSP, no tool/fs/http
 * bridge — §S.1), so it's purely for display/interaction and can't act on the app
 * or reach the network. No side effects here: it just packages the HTML as an
 * artifact on the tool result, which the loop attaches to the call.
 */

const MAX_ARTIFACT_HTML = 512 * 1024;

function strProp(description: string): { type: 'string'; description: string } {
  return { type: 'string', description };
}

async function createArtifactTool(input: Record<string, unknown>): Promise<ToolResult> {
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 120) : '';
  const html = typeof input.html === 'string' ? input.html : '';
  if (!html.trim()) {
    return { summary: 'create_artifact failed', text: 'create_artifact requires non-empty "html".', isError: true };
  }
  if (html.length > MAX_ARTIFACT_HTML) {
    return {
      summary: 'create_artifact failed',
      text: `html too large (${html.length} bytes; limit ${MAX_ARTIFACT_HTML}). Inline only what's needed.`,
      isError: true,
    };
  }
  const name = title || 'Artifact';
  return {
    summary: `artifact: ${name}`,
    text:
      `Rendered interactive artifact "${name}" (${html.length} bytes) in the chat. It runs in a ` +
      `sandboxed, network-isolated frame — display only, so don't rely on it to fetch data or act.`,
    artifact: { title: name, html },
  };
}

export const CREATE_ARTIFACT_TOOL: McpTool = {
  name: 'create_artifact',
  description:
    'Render a self-contained interactive HTML artifact (chart, form, dashboard, diagram, mini-app) inline in the chat for the user to see and interact with. Provide a complete HTML document or fragment with ALL CSS and JS inlined — no external resources (the frame is NETWORK-ISOLATED and same-origin-isolated, so fetch/CDN/links will not work). It cannot access the app, the page, files, or other tools — it is display only. Do NOT use it to perform work, fetch data, or run agent logic; use real tools for that.',
  inputSchema: {
    type: 'object',
    properties: {
      title: strProp('Short title shown on the artifact card.'),
      html: strProp('Complete, self-contained HTML with all CSS/JS inlined. No external/network resources.'),
    },
    required: ['html'],
    additionalProperties: false,
  },
  group: 'files',
  gated: false,
  write: false,
  requiresWorkspace: false,
  exec: createArtifactTool,
};
