import { z } from 'zod';
import type { ModelEntry } from '../../../shared/providers';
import type { ModelAuth } from '../model';
import {
  downloadBinary,
  endpoint,
  getJson,
  postJson,
  tokenOf,
  wait,
  VideoTimeoutError,
} from './video-generation-http';
import {
  openAiSeconds,
  openAiSize,
  VIDEO_POLL_INTERVAL_MS,
  type DownloadedVideo,
  type VideoRequest,
} from './video-generation-request';

const OpenAiVideoSchema = z.object({
  id: z.string(),
  status: z.enum(['queued', 'in_progress', 'completed', 'failed']),
  progress: z.number().optional(),
  error: z.object({ message: z.string().optional(), code: z.string().optional() }).optional(),
});

async function pollOpenAiVideo(input: {
  readonly candidate: ModelEntry;
  readonly token: string;
  readonly baseUrl: string;
  readonly jobId: string;
  readonly waitMs: number;
  readonly signal: AbortSignal;
}): Promise<z.infer<typeof OpenAiVideoSchema>> {
  const deadline = Date.now() + input.waitMs;
  let current = OpenAiVideoSchema.parse(
    await getJson({
      url: endpoint(input.baseUrl, `/videos/${input.jobId}`),
      provider: input.candidate.provider,
      token: input.token,
      signal: input.signal,
    }),
  );
  while (current.status === 'queued' || current.status === 'in_progress') {
    if (Date.now() >= deadline) throw new VideoTimeoutError(input.jobId);
    await wait(VIDEO_POLL_INTERVAL_MS, input.signal);
    current = OpenAiVideoSchema.parse(
      await getJson({
        url: endpoint(input.baseUrl, `/videos/${input.jobId}`),
        provider: input.candidate.provider,
        token: input.token,
        signal: input.signal,
      }),
    );
  }
  if (current.status === 'failed') {
    throw new Error(current.error?.message ?? `OpenAI video job ${input.jobId} failed`);
  }
  return current;
}

export async function createOpenAiVideo(input: {
  readonly candidate: ModelEntry;
  readonly auth: ModelAuth;
  readonly baseUrl: string;
  readonly request: VideoRequest;
  readonly signal: AbortSignal;
}): Promise<DownloadedVideo> {
  const token = tokenOf(input.auth);
  const body: Record<string, unknown> = {
    model: input.candidate.id,
    prompt: input.request.prompt,
    seconds: openAiSeconds(input.request.durationSeconds),
    size: openAiSize(input.request.aspectRatio),
  };
  if (input.request.referenceImageUrl) {
    body.input_reference = { image_url: input.request.referenceImageUrl };
  }
  const created = OpenAiVideoSchema.parse(
    await postJson({
      url: endpoint(input.baseUrl, '/videos'),
      provider: input.candidate.provider,
      token,
      body,
      signal: input.signal,
    }),
  );
  const completed = await pollOpenAiVideo({
    candidate: input.candidate,
    token,
    baseUrl: input.baseUrl,
    jobId: created.id,
    waitMs: input.request.waitMs,
    signal: input.signal,
  });
  const downloaded = await downloadBinary({
    url: endpoint(input.baseUrl, `/videos/${completed.id}/content?variant=video`),
    provider: input.candidate.provider,
    token,
    signal: input.signal,
  });
  return { ...downloaded, remoteId: completed.id };
}
