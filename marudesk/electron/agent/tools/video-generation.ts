import {
  MODELS,
  customProviderId,
  mergeInferredModelCapabilities,
  modelKey,
  rankVideoGenerationModels,
  type ModelEntry,
} from '../../../shared/providers';
import { scrubText } from '../../../shared/scrub';
import { listCustomProviders } from '../../custom-providers';
import { humanizeModelError, type ModelAuth } from '../model';
import { resolveProviderAuth } from '../resolve-auth';
import { ensureWorkspaceDirectory, parseOutputDir, saveGeneratedFile } from './media-files';
import { baseUrlFor } from './video-generation-http';
import { createOpenAiVideo } from './video-generation-openai';
import {
  DEFAULT_VIDEO_OUTPUT_DIR,
  extensionForVideo,
  parseVideoRequest,
  type DownloadedVideo,
  type VideoRequest,
} from './video-generation-request';
import { createXaiVideo } from './video-generation-xai';
import type { McpTool, ToolContext, ToolResult } from './types';

function strProp(desc: string): { type: 'string'; description: string } {
  return { type: 'string', description: desc };
}

function customEntries(customs: Awaited<ReturnType<typeof listCustomProviders>>): ModelEntry[] {
  return customs.flatMap((custom) =>
    custom.models.map((model) => {
      const provider = customProviderId(custom.id);
      return mergeInferredModelCapabilities({
        key: modelKey(provider, model.id),
        id: model.id,
        label: model.label,
        provider,
        contextWindow: model.contextWindow,
        tools: model.tools,
      });
    }),
  );
}

async function videoCatalog(): Promise<ModelEntry[]> {
  return [...MODELS, ...customEntries(await listCustomProviders())];
}

function selectedModelKey(ctx: ToolContext): string | undefined {
  if (!ctx.provider || !ctx.model) return undefined;
  return modelKey(ctx.provider, ctx.model);
}

async function createVideo(input: {
  readonly candidate: ModelEntry;
  readonly auth: ModelAuth;
  readonly baseUrl: string | undefined;
  readonly request: VideoRequest;
  readonly signal: AbortSignal;
}): Promise<DownloadedVideo> {
  const baseUrl = baseUrlFor(input.candidate, input.baseUrl);
  switch (input.candidate.videoTransport) {
    case 'openai-videos':
    case 'openai-compatible-videos':
      return createOpenAiVideo({ ...input, baseUrl });
    case 'xai-videos':
      return createXaiVideo({ ...input, baseUrl });
    default:
      throw new Error(`${input.candidate.provider}:${input.candidate.id} is not a video generation model`);
  }
}

async function generateVideoTool(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.ws) {
    return {
      summary: 'generate_video (no workspace)',
      text: 'No folder is open, so generated videos cannot be saved. Open a workspace first.',
      isError: true,
    };
  }
  const workspace = ctx.ws;
  const request = parseVideoRequest(input);
  const outputDir = await ensureWorkspaceDirectory(
    workspace.root,
    parseOutputDir(input.outputDir, DEFAULT_VIDEO_OUTPUT_DIR),
  );
  const candidates = rankVideoGenerationModels({
    models: await videoCatalog(),
    selectedModelKey: selectedModelKey(ctx),
    preferredProvider: ctx.provider,
  });
  const authFailures: string[] = [];
  for (const candidate of candidates) {
    const resolved = await resolveProviderAuth(candidate.provider);
    if (!resolved.ok) {
      authFailures.push(`${candidate.provider}: ${resolved.reason}`);
      continue;
    }
    try {
      const video = await createVideo({
        candidate,
        auth: resolved.auth,
        baseUrl: resolved.baseUrl,
        request,
        signal: ctx.signal,
      });
      const saved = await saveGeneratedFile({
        root: workspace.root,
        outputDir,
        bytes: video.bytes,
        extension: extensionForVideo(video.mediaType),
        denyGlobs: ctx.denyGlobs,
      });
      return {
        summary: 'generated 1 video',
        text: [
          `Model: ${candidate.provider}:${candidate.id}`,
          `Remote job: ${video.remoteId}`,
          `Saved: ${saved}`,
        ].join('\n'),
      };
    } catch (err) {
      const modelError = err instanceof Error ? err : new Error(String(err));
      return {
        summary: `generate_video ${candidate.label} failed`,
        text: scrubText(humanizeModelError(modelError, candidate.provider, candidate.id)),
        isError: true,
      };
    }
  }
  return {
    summary: 'generate_video unavailable',
    text:
      authFailures.length > 0
        ? `No connected video-generation model was available.\n${authFailures.join('\n')}`
        : 'No video-generation-capable model is configured. Connect OpenAI/xAI or add a custom video-capable model.',
    isError: true,
  };
}

export const VIDEO_GENERATION_TOOL: McpTool = {
  name: 'generate_video',
  description:
    'Generate a video from a prompt using the configured video-capable provider/model. Prefer the current provider when it has a video model; otherwise use another connected video-capable provider. Saves the finished video under the workspace and returns its relative path.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: strProp('Video prompt. Describe shot type, subject, motion, setting, lighting, and camera movement.'),
      aspectRatio: {
        type: 'string',
        enum: ['16:9', '9:16'],
        description: 'Optional aspect ratio. Defaults to 16:9.',
      },
      durationSeconds: {
        type: 'number',
        description: 'Approximate duration in seconds. Defaults to 8. OpenAI is rounded to 4, 8, or 12; xAI accepts 4-15.',
      },
      referenceImageUrl: strProp('Optional http(s) or data:image URL to guide image-to-video generation.'),
      outputDir: strProp('Optional workspace-relative output directory. Defaults to generated/videos.'),
      waitMs: {
        type: 'number',
        description: 'Optional maximum wait for completion in milliseconds, capped at 600000. Defaults to 300000.',
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  group: 'files',
  gated: true,
  write: true,
  requiresWorkspace: true,
  exec: generateVideoTool,
};
