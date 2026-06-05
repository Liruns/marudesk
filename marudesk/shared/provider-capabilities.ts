import {
  findModel,
  isCustomProviderId,
  type ImageGenerationTransport,
  type ModelEntry,
  type ProviderId,
  type VideoGenerationTransport,
} from './providers.ts';

/**
 * Image/video generation capability inference + ranking, split out of
 * providers.ts. A model's media capabilities are inferred from its provider + id
 * pattern (so a newly-listed image/video model works without a catalog edit),
 * then merged over any explicit catalog flags. Pure — no catalog state beyond
 * the `models` arrays passed in.
 */

type ImageGenerationCapability = {
  imageGeneration?: boolean;
  imageEdit?: boolean;
  imageTransport?: ImageGenerationTransport;
};

type VideoGenerationCapability = {
  videoGeneration?: boolean;
  videoEdit?: boolean;
  videoTransport?: VideoGenerationTransport;
};

export function inferImageGenerationCapability(
  provider: ProviderId,
  modelId: string,
): ImageGenerationCapability {
  const id = modelId.toLowerCase();
  if (provider === 'openai' && (/^gpt-image-/.test(id) || /^dall-e-/.test(id))) {
    return {
      imageGeneration: true,
      imageEdit: /^gpt-image-/.test(id) || id === 'dall-e-2',
      imageTransport: 'openai-images',
    };
  }
  if ((provider === 'xai' || isCustomProviderId(provider)) && /^grok-imagine-image/.test(id)) {
    return {
      imageGeneration: true,
      imageEdit: true,
      imageTransport: 'openai-compatible-images',
    };
  }
  if (isCustomProviderId(provider) && (/^gpt-image-/.test(id) || /^dall-e-/.test(id))) {
    return {
      imageGeneration: true,
      imageEdit: /^gpt-image-/.test(id) || id === 'dall-e-2',
      imageTransport: 'openai-compatible-images',
    };
  }
  return {};
}

export function inferVideoGenerationCapability(
  provider: ProviderId,
  modelId: string,
): VideoGenerationCapability {
  const id = modelId.toLowerCase();
  if (provider === 'openai' && /^sora-2/.test(id)) {
    return {
      videoGeneration: true,
      videoEdit: true,
      videoTransport: 'openai-videos',
    };
  }
  if ((provider === 'xai' || isCustomProviderId(provider)) && /^grok-imagine-video/.test(id)) {
    return {
      videoGeneration: true,
      videoEdit: true,
      videoTransport: 'xai-videos',
    };
  }
  if (isCustomProviderId(provider) && /^sora-2/.test(id)) {
    return {
      videoGeneration: true,
      videoEdit: true,
      videoTransport: 'openai-compatible-videos',
    };
  }
  return {};
}

export function mergeInferredModelCapabilities(entry: ModelEntry): ModelEntry {
  const inferred = inferImageGenerationCapability(entry.provider, entry.id);
  const inferredVideo = inferVideoGenerationCapability(entry.provider, entry.id);
  const imageGeneration = entry.imageGeneration ?? inferred.imageGeneration;
  const videoGeneration = entry.videoGeneration ?? inferredVideo.videoGeneration;
  return {
    ...entry,
    tools: entry.tools ?? (imageGeneration || videoGeneration ? false : true),
    imageGeneration,
    imageEdit: entry.imageEdit ?? inferred.imageEdit,
    imageTransport: entry.imageTransport ?? inferred.imageTransport,
    videoGeneration,
    videoEdit: entry.videoEdit ?? inferredVideo.videoEdit,
    videoTransport: entry.videoTransport ?? inferredVideo.videoTransport,
  };
}

function imageCapable(model: ModelEntry): boolean {
  const entry = mergeInferredModelCapabilities(model);
  return entry.imageGeneration === true && !!entry.imageTransport;
}

function videoCapable(model: ModelEntry): boolean {
  const entry = mergeInferredModelCapabilities(model);
  return entry.videoGeneration === true && !!entry.videoTransport;
}

function pushUniqueMedia(
  target: ModelEntry[],
  seen: Set<string>,
  candidate: ModelEntry | undefined,
  capable: (model: ModelEntry) => boolean,
): void {
  if (!candidate || seen.has(candidate.key) || !capable(candidate)) return;
  seen.add(candidate.key);
  target.push(mergeInferredModelCapabilities(candidate));
}

function rankGenerationModels(input: {
  models: readonly ModelEntry[];
  selectedModelKey?: string;
  preferredProvider?: ProviderId;
  capable: (model: ModelEntry) => boolean;
}): ModelEntry[] {
  const all = input.models.map(mergeInferredModelCapabilities);
  const selected = input.selectedModelKey ? findModel(all, input.selectedModelKey) : undefined;
  const provider = input.preferredProvider ?? selected?.provider;
  const ranked: ModelEntry[] = [];
  const seen = new Set<string>();
  pushUniqueMedia(ranked, seen, selected, input.capable);
  if (provider) {
    for (const model of all.filter((m) => m.provider === provider)) {
      pushUniqueMedia(ranked, seen, model, input.capable);
    }
  }
  for (const model of all) pushUniqueMedia(ranked, seen, model, input.capable);
  return ranked;
}

export function rankImageGenerationModels(input: {
  models: readonly ModelEntry[];
  selectedModelKey?: string;
  preferredProvider?: ProviderId;
}): ModelEntry[] {
  return rankGenerationModels({ ...input, capable: imageCapable });
}

export function rankVideoGenerationModels(input: {
  models: readonly ModelEntry[];
  selectedModelKey?: string;
  preferredProvider?: ProviderId;
}): ModelEntry[] {
  return rankGenerationModels({ ...input, capable: videoCapable });
}
