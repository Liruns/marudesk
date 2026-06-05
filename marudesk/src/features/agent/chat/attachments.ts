import type { AgentImageInput } from '../../../../shared/agent';

const MAX_FILE_TEXT_CHARS = 24_000;
const MAX_FILE_ATTACHMENTS = 8;

export type PendingFileAttachment = {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly text: string;
  readonly truncated: boolean;
};

export async function readImageFiles(files: readonly File[]): Promise<AgentImageInput[]> {
  const images = files.filter((file) => file.type.startsWith('image/'));
  const decoded = await Promise.all(images.map((file) => readImageFile(file).catch(() => null)));
  return decoded.filter((image): image is AgentImageInput => image !== null);
}

export async function fileAttachmentsFromFiles(files: readonly File[]): Promise<PendingFileAttachment[]> {
  const attachments = await Promise.all(files
    .filter((file) => !file.type.startsWith('image/'))
    .slice(0, MAX_FILE_ATTACHMENTS)
    .map(fileAttachmentFromFile));
  return dedupeFiles(attachments);
}

export function mergeFileAttachments(
  existing: readonly PendingFileAttachment[],
  incoming: readonly PendingFileAttachment[],
): PendingFileAttachment[] {
  return dedupeFiles([...existing, ...incoming]).slice(0, MAX_FILE_ATTACHMENTS);
}

export function formatAttachedFilesForPrompt(files: readonly PendingFileAttachment[]): string {
  if (files.length === 0) return '';
  const blocks = files.map((file) => {
    const meta = `${file.name} (${formatBytes(file.size)}${file.type ? `, ${file.type}` : ''}${
      file.truncated ? ', clipped' : ''
    })`;
    return [`File: ${meta}`, '```text', file.text || '(empty file)', '```'].join('\n');
  });
  return `Attached files:\n\n${blocks.join('\n\n')}`;
}

async function readImageFile(file: File): Promise<AgentImageInput> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  return { mediaType: file.type, data: bytesToBase64(bytes) };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte !== undefined) binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function fileAttachmentFromFile(file: File): Promise<PendingFileAttachment> {
  const raw = await file.slice(0, MAX_FILE_TEXT_CHARS).text();
  const clipped = file.size > MAX_FILE_TEXT_CHARS || raw.length > MAX_FILE_TEXT_CHARS;
  return {
    name: file.name || 'attached-file',
    size: file.size,
    type: file.type,
    text: clipped ? raw.slice(0, MAX_FILE_TEXT_CHARS) : raw,
    truncated: clipped,
  };
}

function dedupeFiles(files: readonly PendingFileAttachment[]): PendingFileAttachment[] {
  const seen = new Set<string>();
  const out: PendingFileAttachment[] = [];
  for (const file of files) {
    const key = `${file.name.toLowerCase()}:${file.size}:${file.text.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
