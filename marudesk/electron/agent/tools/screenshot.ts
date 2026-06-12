import { MODELS, type ProviderId } from '../../../shared/providers';
import { getActiveTabId, getTab, type TabRecord } from '../../browser/state';
import type { ToolContext, ToolResult } from './types';

/**
 * The `screenshot` tool: capture a web tab as an image and hand it to the model
 * as an image part of the tool result, so a vision-capable model can SEE the
 * page — closing the visual loop (edit → reload_and_verify → screenshot →
 * "does it look right"). Uses the main process's `webContents.capturePage()`
 * (no CDP needed, so it works even when the built-in DevTools holds the CDP
 * client). The image is downscaled + JPEG-compressed so a capture never floods
 * the context window.
 */

/** Downscale ceiling — wide enough to read UI text, small enough to stay cheap. */
const MAX_WIDTH = 1024;
const JPEG_QUALITY = 80;

/**
 * Providers whose AI SDK message mapping forwards a tool-result `image-data`
 * part natively (verified against the installed @ai-sdk/* converters):
 * anthropic → tool_result image block, openai/openai-codex → input_image,
 * google/google-caa → inlineData. xAI's responses mapping DROPS non-text parts
 * and the openai-compatible path JSON-stringifies the array (which would dump
 * base64 into the context), so those fall back to text-only.
 */
const IMAGE_TOOL_RESULT_PROVIDERS = new Set<ProviderId>([
  'anthropic',
  'openai',
  'openai-codex',
  'google',
  'google-caa',
]);

/** Whether the turn's model can actually receive this tool result's image. */
function modelAcceptsToolImages(ctx: ToolContext): boolean {
  if (!ctx.provider || !ctx.model) return false;
  if (!IMAGE_TOOL_RESULT_PROVIDERS.has(ctx.provider)) return false;
  const vision = MODELS.find((m) => m.provider === ctx.provider && m.id === ctx.model)?.vision;
  return vision ?? false;
}

/**
 * Resolve the capture target: an explicit tabId (from list_tabs), else the
 * turn's active web tab. Unlike the CDP tools this does NOT refuse a tab whose
 * built-in DevTools is open — capturePage doesn't need the CDP client.
 */
function resolveCaptureTab(tabId: unknown, ctx: ToolContext): TabRecord {
  const id = typeof tabId === 'string' && tabId ? tabId : ctx.tabId ?? getActiveTabId();
  if (!id) throw new Error('no web tab — open a page, or pass a tabId from list_tabs');
  const rec = getTab(id);
  if (!rec || rec.kind !== 'web' || !rec.view) {
    throw new Error(`tab ${id} is not a live web page (use list_tabs to see web tabs)`);
  }
  return rec;
}

export async function screenshot(
  input: { tabId?: unknown },
  ctx: ToolContext,
): Promise<ToolResult> {
  const rec = resolveCaptureTab(input.tabId, ctx);
  const image = await rec.view!.webContents.capturePage();
  if (image.isEmpty()) {
    return {
      summary: 'screenshot failed',
      text: 'capture produced an empty image — the tab may be hidden or still loading; activate it (activate_tab) and retry',
      isError: true,
    };
  }
  const { width, height } = image.getSize();
  const scaled = width > MAX_WIDTH ? image.resize({ width: MAX_WIDTH }) : image;
  const sent = scaled.getSize();
  if (!modelAcceptsToolImages(ctx)) {
    return {
      summary: `screenshot ${width}×${height} (no vision)`,
      text: `Screenshot captured (${width}×${height} px), but the active model does not accept images in tool results — the capture was discarded. Inspect the page with query_dom / read_page instead, or ask the user to switch to a vision-capable model.`,
    };
  }
  const jpeg = scaled.toJPEG(JPEG_QUALITY);
  return {
    summary: `screenshot ${sent.width}×${sent.height}`,
    text: `Screenshot of the page (viewport ${width}×${height} px, sent as ${sent.width}×${sent.height} JPEG). The image is attached to this tool result.`,
    image: { data: jpeg.toString('base64'), mediaType: 'image/jpeg' },
  };
}
