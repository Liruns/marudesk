const MAX_PROMPT = 4_000;
const DEFAULT_DURATION_SECONDS = 8;
const DEFAULT_WAIT_MS = 300_000;
const MAX_WAIT_MS = 600_000;
export const VIDEO_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_VIDEO_OUTPUT_DIR = 'generated/videos';

export type VideoAspectRatio = '16:9' | '9:16';
export type OpenAiVideoSize = '1280x720' | '720x1280';
export type OpenAiVideoSeconds = '4' | '8' | '12';

export type VideoRequest = {
  readonly prompt: string;
  readonly aspectRatio: VideoAspectRatio;
  readonly durationSeconds: number;
  readonly referenceImageUrl?: string;
  readonly waitMs: number;
};

export type DownloadedVideo = {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly remoteId: string;
};

function parsePrompt(input: Record<string, unknown>): string {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) throw new Error('generate_video requires "prompt"');
  return prompt.length > MAX_PROMPT ? prompt.slice(0, MAX_PROMPT) : prompt;
}

function parseAspectRatio(value: unknown): VideoAspectRatio {
  if (typeof value !== 'string' || value.trim().length === 0) return '16:9';
  const ratio = value.trim();
  if (ratio === '16:9' || ratio === '9:16') return ratio;
  throw new Error('aspectRatio must be one of 16:9, 9:16');
}

function parseDurationSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_DURATION_SECONDS;
  return Math.min(Math.max(Math.round(value), 4), 15);
}

function parseReferenceImageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const url = value.trim();
  if (!/^https?:\/\//i.test(url) && !/^data:image\//i.test(url)) {
    throw new Error('referenceImageUrl must be an http(s) URL or a data:image URL');
  }
  return url;
}

function parseWaitMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_WAIT_MS;
  return Math.min(Math.max(Math.round(value), VIDEO_POLL_INTERVAL_MS), MAX_WAIT_MS);
}

export function parseVideoRequest(input: Record<string, unknown>): VideoRequest {
  return {
    prompt: parsePrompt(input),
    aspectRatio: parseAspectRatio(input.aspectRatio),
    durationSeconds: parseDurationSeconds(input.durationSeconds),
    referenceImageUrl: parseReferenceImageUrl(input.referenceImageUrl),
    waitMs: parseWaitMs(input.waitMs),
  };
}

export function openAiSeconds(seconds: number): OpenAiVideoSeconds {
  if (seconds <= 6) return '4';
  if (seconds <= 10) return '8';
  return '12';
}

export function openAiSize(aspectRatio: VideoAspectRatio): OpenAiVideoSize {
  return aspectRatio === '9:16' ? '720x1280' : '1280x720';
}

export function extensionForVideo(mediaType: string): string {
  const type = mediaType.toLowerCase();
  if (type.includes('webm')) return 'webm';
  if (type.includes('quicktime') || type.includes('mov')) return 'mov';
  return 'mp4';
}
