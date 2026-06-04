import type {
  ReadFileResult,
  WorkspaceImageMediaType,
} from '../../../shared/workspace';

type LoadingFileBuf = { status: 'loading' };

export type TextFileBuf = {
  status: 'ready';
  kind: 'text';
  content: string;
  saved?: string;
  saving?: boolean;
  error?: string;
};

export type ImageFileBuf = {
  status: 'ready';
  kind: 'image';
  mediaType: WorkspaceImageMediaType;
  dataUrl: string;
  size: number;
};

export type ErrorFileBuf = {
  status: 'error';
  reason?: 'too-large' | 'binary' | 'not-a-file';
  size?: number;
  error?: string;
};

export type FileBuf = LoadingFileBuf | TextFileBuf | ImageFileBuf | ErrorFileBuf;

export function isTextFileBuf(buf: FileBuf | undefined): buf is TextFileBuf {
  return !!buf && buf.status === 'ready' && buf.kind === 'text';
}

export function readResultToFileBuf(
  res: Extract<ReadFileResult, { ok: true }>,
): FileBuf {
  switch (res.kind) {
    case 'image':
      return {
        status: 'ready',
        kind: 'image',
        mediaType: res.mediaType,
        dataUrl: res.dataUrl,
        size: res.size,
      };
    case 'text':
      return {
        status: 'ready',
        kind: 'text',
        content: res.content,
        saved: res.content,
      };
    default:
      return assertNever(res);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected workspace read variant: ${JSON.stringify(value)}`);
}
