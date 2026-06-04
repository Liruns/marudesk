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
  VIDEO_POLL_INTERVAL_MS,
  type DownloadedVideo,
  type VideoRequest,
} from './video-generation-request';

const XaiVideoCreateSchema = z.object({
  request_id: z.string(),
});

const XaiVideoStatusSchema = z.object({
  status: z.enum([
    'pending',
    'queued',
    'generating',
    'processing',
    'in_progress',
    'done',
    'failed',
    'expired',
  ]),
  video: z.object({ url: z.string().min(1) }).optional(),
  error: z.union([z.string(), z.object({ message: z.string().optional() })]).optional(),
  message: z.string().optional(),
});

function xaiFailureMessage(parsed: z.infer<typeof XaiVideoStatusSchema>): string {
  if (typeof parsed.error === 'string') return parsed.error;
  if (parsed.error?.message) return parsed.error.message;
  return parsed.message ?? `xAI video request ${parsed.status}`;
}

function isPending(status: z.infer<typeof XaiVideoStatusSchema>['status']): boolean {
  return (
    status === 'pending' ||
    status === 'queued' ||
    status === 'generating' ||
    status === 'processing' ||
    status === 'in_progress'
  );
}

function parseProviderVideoUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:') {
    throw new Error('provider video download URL must use https');
  }
  return url.toString();
}

export async function createXaiVideo(input: {
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
    duration: input.request.durationSeconds,
    aspect_ratio: input.request.aspectRatio,
    resolution: '720p',
  };
  if (input.request.referenceImageUrl) {
    body.image = { url: input.request.referenceImageUrl };
  }
  const created = XaiVideoCreateSchema.parse(
    await postJson({
      url: endpoint(input.baseUrl, '/videos/generations'),
      provider: input.candidate.provider,
      token,
      body,
      signal: input.signal,
    }),
  );
  const deadline = Date.now() + input.request.waitMs;
  let current = XaiVideoStatusSchema.parse(
    await getJson({
      url: endpoint(input.baseUrl, `/videos/${created.request_id}`),
      provider: input.candidate.provider,
      token,
      signal: input.signal,
    }),
  );
  while (isPending(current.status)) {
    if (Date.now() >= deadline) throw new VideoTimeoutError(created.request_id);
    await wait(VIDEO_POLL_INTERVAL_MS, input.signal);
    current = XaiVideoStatusSchema.parse(
      await getJson({
        url: endpoint(input.baseUrl, `/videos/${created.request_id}`),
        provider: input.candidate.provider,
        token,
        signal: input.signal,
      }),
    );
  }
  if (current.status === 'failed' || current.status === 'expired') {
    throw new Error(xaiFailureMessage(current));
  }
  if (!current.video?.url) {
    throw new Error(`xAI video request ${created.request_id} completed without a video URL`);
  }
  const videoUrl = parseProviderVideoUrl(current.video.url);
  const downloaded = await downloadBinary({
    url: videoUrl,
    provider: input.candidate.provider,
    signal: input.signal,
  });
  return { ...downloaded, remoteId: created.request_id };
}
