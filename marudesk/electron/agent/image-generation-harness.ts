import assert from 'node:assert/strict';
import {
  MODELS,
  modelKey,
  rankImageGenerationModels,
  rankVideoGenerationModels,
  type ModelEntry,
} from '../../shared/providers.ts';

function check(label: string, cond: boolean): void {
  assert.ok(cond, label);
  console.log(`ok - ${label}`);
}

function firstKey(candidates: readonly ModelEntry[]): string | null {
  return candidates[0]?.key ?? null;
}

function main(): void {
  check(
    'OpenAI chat selection routes image generation to GPT Image 2',
    firstKey(
      rankImageGenerationModels({
        models: MODELS,
        selectedModelKey: modelKey('openai', 'gpt-5'),
      }),
    ) === modelKey('openai', 'gpt-image-2'),
  );

  check(
    'xAI chat selection routes image generation to Grok Imagine quality',
    firstKey(
      rankImageGenerationModels({
        models: MODELS,
        selectedModelKey: modelKey('xai', 'grok-4.3'),
      }),
    ) === modelKey('xai', 'grok-imagine-image-quality'),
  );

  check(
    'an image model selection is kept as the first candidate',
    firstKey(
      rankImageGenerationModels({
        models: MODELS,
        selectedModelKey: modelKey('openai', 'gpt-image-2'),
      }),
    ) === modelKey('openai', 'gpt-image-2'),
  );

  check(
    'OpenAI chat selection routes video generation to Sora 2',
    firstKey(
      rankVideoGenerationModels({
        models: MODELS,
        selectedModelKey: modelKey('openai', 'gpt-5'),
      }),
    ) === modelKey('openai', 'sora-2'),
  );

  check(
    'xAI chat selection routes video generation to Grok Imagine Video',
    firstKey(
      rankVideoGenerationModels({
        models: MODELS,
        selectedModelKey: modelKey('xai', 'grok-4.3'),
      }),
    ) === modelKey('xai', 'grok-imagine-video'),
  );

  check(
    'a video model selection is kept as the first candidate',
    firstKey(
      rankVideoGenerationModels({
        models: MODELS,
        selectedModelKey: modelKey('openai', 'sora-2-pro'),
      }),
    ) === modelKey('openai', 'sora-2-pro'),
  );
}

main();
