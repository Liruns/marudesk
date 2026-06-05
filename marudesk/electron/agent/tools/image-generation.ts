import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateImage } from 'ai';
import {
  MODELS,
  customProviderId,
  mergeInferredModelCapabilities,
  modelKey,
  rankImageGenerationModels,
  type ModelEntry,
  type ProviderId,
} from '../../../shared/providers';
import { scrubText } from '../../../shared/scrub';
import { globToRegExp } from '../../../shared/glob';
import { listCustomProviders } from '../../custom-providers';
import {
  assertRealInsideRoot,
  assertRealParentInsideRoot,
  lstatOrNull,
  resolveWorkspacePath,
} from '../../fs-safe';
import { humanizeModelError, isFailoverError, type ModelAuth } from '../model';
import { resolveProviderAuth } from '../resolve-auth';
import type { McpTool, ToolContext, ToolResult } from './types';

const XAI_BASE_URL = 'https://api.x.ai/v1';
const DEFAULT_OUTPUT_DIR = 'generated/images';
const MAX_PROMPT = 4_000;
const MAX_IMAGES = 4;
type ImageAspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
type ImageSize = `${number}x${number}`;
type ImageRequestOptions = {
  readonly size?: ImageSize;
  readonly providerOptions?: Record<string, { readonly aspect_ratio: ImageAspectRatio }>;
};

type GeneratedImageFile = {
  readonly uint8Array: Uint8Array;
  readonly mediaType?: string;
  readonly mimeType?: string;
};

function strProp(desc: string): { type: 'string'; description: string } {
  return { type: 'string', description: desc };
}

function parsePrompt(input: Record<string, unknown>): string {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) throw new Error('generate_image requires "prompt"');
  return prompt.length > MAX_PROMPT ? prompt.slice(0, MAX_PROMPT) : prompt;
}

function isAspectRatio(value: string): value is ImageAspectRatio {
  return value === '1:1' || value === '16:9' || value === '9:16' || value === '4:3' || value === '3:4';
}

function parseAspectRatio(value: unknown): ImageAspectRatio | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const ratio = value.trim();
  if (!isAspectRatio(ratio)) {
    throw new Error('aspectRatio must be one of 1:1, 16:9, 9:16, 4:3, 3:4');
  }
  return ratio;
}

function parseCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 1;
  return Math.min(Math.max(value, 1), MAX_IMAGES);
}

function parseOutputDir(value: unknown): string {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_OUTPUT_DIR;
  return raw.replace(/\\/g, '/').replace(/\/+$/g, '') || DEFAULT_OUTPUT_DIR;
}

function assertNotDenied(rel: string, denyGlobs: readonly string[] | undefined): void {
  if (!denyGlobs?.some((glob) => globToRegExp(glob).test(rel))) return;
  throw new Error(`Blocked: "${rel}" matches a denied path glob (Settings → Agent).`);
}

const OPENAI_SIZE_BY_ASPECT_RATIO = {
  '1:1': '1024x1024',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
  '4:3': '1536x1024',
  '3:4': '1024x1536',
} as const satisfies Record<ImageAspectRatio, ImageSize>;

function isGrokImagineModel(modelId: string): boolean {
  return modelId.toLowerCase().startsWith('grok-imagine-image');
}

function imageRequestOptions(candidate: ModelEntry, aspectRatio: ImageAspectRatio | undefined): ImageRequestOptions {
  if (!aspectRatio) return {};
  if (candidate.imageTransport === 'openai-compatible-images' && isGrokImagineModel(candidate.id)) {
    return {
      providerOptions: {
        [candidate.provider]: { aspect_ratio: aspectRatio },
      },
    };
  }
  return { size: OPENAI_SIZE_BY_ASPECT_RATIO[aspectRatio] };
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

async function imageCatalog(): Promise<ModelEntry[]> {
  return [...MODELS, ...customEntries(await listCustomProviders())];
}

async function ensureWorkspaceDirectory(root: string, relDir: string): Promise<{ readonly rel: string; readonly abs: string }> {
  const raw = resolveWorkspacePath(root, relDir);
  const resolved = {
    rel: path.relative(root, raw.abs).replace(/\\/g, '/') || '.',
    abs: raw.abs,
  };
  const segments = resolved.rel.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  let currentRel = '';
  for (const segment of segments) {
    currentRel = currentRel ? `${currentRel}/${segment}` : segment;
    const current = resolveWorkspacePath(root, currentRel);
    const existing = await lstatOrNull(current.abs);
    if (existing) {
      if (!existing.isDirectory()) throw new Error(`marudesk: path is not a directory: ${current.rel}`);
      await assertRealInsideRoot(root, current.abs);
      continue;
    }
    await assertRealParentInsideRoot(root, current.abs);
    await fs.mkdir(current.abs, { recursive: false });
  }
  await assertRealInsideRoot(root, resolved.abs);
  return resolved;
}

function selectedModelKey(ctx: ToolContext): string | undefined {
  if (!ctx.provider || !ctx.model) return undefined;
  return modelKey(ctx.provider, ctx.model);
}

function imageBaseUrl(provider: ProviderId, baseUrl: string | undefined): string {
  if (provider === 'xai') return XAI_BASE_URL;
  if (baseUrl) return baseUrl;
  throw new Error(`provider ${provider} has no image base URL`);
}

function buildImageModel(candidate: ModelEntry, auth: ModelAuth, baseUrl: string | undefined) {
  const token = auth.mode === 'oauth' ? auth.accessToken : auth.apiKey;
  switch (candidate.imageTransport) {
    case 'openai-images':
      return createOpenAI({ apiKey: token }).image(candidate.id);
    case 'openai-compatible-images':
      return createOpenAICompatible({
        name: candidate.provider,
        baseURL: imageBaseUrl(candidate.provider, baseUrl),
        apiKey: token || undefined,
      }).imageModel(candidate.id);
    default:
      throw new Error(`${candidate.provider}:${candidate.id} is not an image generation model`);
  }
}

function mediaTypeOf(image: GeneratedImageFile, candidate: ModelEntry): string {
  const mediaType = image.mediaType ?? image.mimeType;
  if (mediaType) return mediaType;
  return candidate.provider === 'xai' ? 'image/jpeg' : 'image/png';
}

function extensionFor(mediaType: string): string {
  if (mediaType === 'image/jpeg' || mediaType === 'image/jpg') return 'jpg';
  if (mediaType === 'image/webp') return 'webp';
  return 'png';
}

type SavedImage = { readonly path: string; readonly mediaType: string };

async function saveGeneratedImage(input: {
  readonly root: string;
  readonly outputDir: { readonly rel: string; readonly abs: string };
  readonly image: GeneratedImageFile;
  readonly candidate: ModelEntry;
  readonly index: number;
  readonly denyGlobs: readonly string[] | undefined;
}): Promise<SavedImage> {
  const mediaType = mediaTypeOf(input.image, input.candidate);
  const ext = extensionFor(mediaType);
  const suffix = input.index === 0 ? '' : `-${input.index + 1}`;
  const filename = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}${suffix}.${ext}`;
  const rel = input.outputDir.rel === '.' ? filename : `${input.outputDir.rel}/${filename}`;
  const resolved = resolveWorkspacePath(input.root, rel);
  assertNotDenied(resolved.rel, input.denyGlobs);
  await assertRealParentInsideRoot(input.root, resolved.abs);
  const file = await fs.open(resolved.abs, 'wx');
  try {
    await file.writeFile(input.image.uint8Array);
  } finally {
    await file.close();
  }
  return { path: resolved.rel, mediaType };
}

async function generateImageTool(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!ctx.ws) {
    return {
      summary: 'generate_image (no workspace)',
      text: 'No folder is open, so generated images cannot be saved. Open a workspace first.',
      isError: true,
    };
  }
  const workspace = ctx.ws;
  const prompt = parsePrompt(input);
  const aspectRatio = parseAspectRatio(input.aspectRatio);
  const count = parseCount(input.count);
  const outputDir = await ensureWorkspaceDirectory(workspace.root, parseOutputDir(input.outputDir));
  const candidates = rankImageGenerationModels({
    models: await imageCatalog(),
    selectedModelKey: selectedModelKey(ctx),
    preferredProvider: ctx.provider,
  });
  const authFailures: string[] = [];
  let lastFailover: { label: string; text: string } | null = null;
  for (const candidate of candidates) {
    const resolved = await resolveProviderAuth(candidate.provider);
    if (!resolved.ok) {
      authFailures.push(`${candidate.provider}: ${resolved.reason}`);
      continue;
    }
    try {
      const result = await generateImage({
        model: buildImageModel(candidate, resolved.auth, resolved.baseUrl),
        prompt,
        n: count,
        abortSignal: ctx.signal,
        ...imageRequestOptions(candidate, aspectRatio),
      });
      const images: readonly GeneratedImageFile[] = result.images;
      if (images.length === 0) {
        return {
          summary: `generate_image ${candidate.label}`,
          text: `${candidate.provider}:${candidate.id} returned no images.`,
          isError: true,
        };
      }
      const saved = await Promise.all(
        images.map((image, index) =>
          saveGeneratedImage({
            root: workspace.root,
            outputDir,
            image,
            candidate,
            index,
            denyGlobs: ctx.denyGlobs,
          }),
        ),
      );
      return {
        summary: `generated ${saved.length} image${saved.length === 1 ? '' : 's'}`,
        text: [
          `Model: ${candidate.provider}:${candidate.id}`,
          `Saved:`,
          ...saved.map((s) => `- ${s.path}`),
        ].join('\n'),
        media: saved.map((s) => ({ kind: 'image' as const, path: s.path, mediaType: s.mediaType })),
      };
    } catch (err) {
      const modelError = err instanceof Error ? err : new Error(String(err));
      const text = scrubText(humanizeModelError(modelError, candidate.provider, candidate.id));
      // Rate-limit (429) / transient server error (5xx): fall over to the next
      // ranked model, mirroring the chat loop's provider fallback. Any other
      // error (bad request, unsupported option) won't be fixed by another model
      // — surface it now rather than burning through the chain.
      if (isFailoverError(err)) {
        lastFailover = { label: candidate.label, text };
        continue;
      }
      return {
        summary: `generate_image ${candidate.label} failed`,
        text,
        isError: true,
      };
    }
  }
  if (lastFailover) {
    return {
      summary: `generate_image ${lastFailover.label} failed`,
      text: lastFailover.text,
      isError: true,
    };
  }
  return {
    summary: 'generate_image unavailable',
    text:
      authFailures.length > 0
        ? `No connected image-generation model was available.\n${authFailures.join('\n')}`
        : 'No image-generation-capable model is configured. Connect OpenAI/xAI or add a custom OpenAI-compatible image model.',
    isError: true,
  };
}

export const IMAGE_GENERATION_TOOL: McpTool = {
  name: 'generate_image',
  description:
    'Generate images from a prompt using the configured image-capable provider/model. Prefer the current provider when it has an image model; otherwise use another connected image-capable provider. Saves image files under the workspace and returns their relative paths.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: strProp('Image prompt. Be specific about subject, style, composition, and constraints.'),
      aspectRatio: {
        type: 'string',
        enum: ['1:1', '16:9', '9:16', '4:3', '3:4'],
        description: 'Optional aspect ratio.',
      },
      count: { type: 'number', description: 'Number of images, 1-4. Defaults to 1.' },
      outputDir: strProp('Optional workspace-relative output directory. Defaults to generated/images.'),
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  group: 'files',
  gated: true,
  write: true,
  requiresWorkspace: true,
  exec: generateImageTool,
};
