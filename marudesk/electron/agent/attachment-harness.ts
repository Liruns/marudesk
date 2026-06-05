import assert from 'node:assert/strict';
import {
  fileAttachmentsFromFiles,
  formatAttachedFilesForPrompt,
  mergeFileAttachments,
  type PendingFileAttachment,
} from '../../src/features/agent/chat/attachments.ts';

let passed = 0;

function check(label: string, cond: boolean): void {
  assert.ok(cond, label);
  passed += 1;
  console.log(`  ok ${passed} - ${label}`);
}

class TrackingTextFile extends File {
  readonly path = '';
  readonly sliceRanges: { readonly start?: number; readonly end?: number }[] = [];

  constructor(name: string, text: string) {
    super([text], name, { type: 'text/plain' });
  }

  override slice(start?: number, end?: number, contentType?: string): Blob {
    this.sliceRanges.push({ start, end });
    return super.slice(start, end, contentType);
  }
}

const bigFile = new TrackingTextFile('big.txt', `${'x'.repeat(24_000)}sentinel-after-limit`);
const bigAttachments = await fileAttachmentsFromFiles([bigFile]);
const bigAttachment = bigAttachments[0];
check('large text attachment is returned', bigAttachment !== undefined);
check('large text attachment is clipped to 24k chars', bigAttachment?.text.length === 24_000);
check('large text attachment records clipping', bigAttachment?.truncated === true);
check('large text attachment is read through file.slice', bigFile.sliceRanges[0]?.start === 0);
check('large text attachment slice caps the read at 24k chars', bigFile.sliceRanges[0]?.end === 24_000);
check('clipped prompt omits text after the read limit', !formatAttachedFilesForPrompt(bigAttachments).includes('sentinel-after-limit'));
check('clipped prompt labels the attachment as clipped', formatAttachedFilesForPrompt(bigAttachments).includes('clipped'));

const tenFiles = Array.from({ length: 10 }, (_, index) => new TrackingTextFile(`file-${index}.txt`, `file ${index}`));
const limitedAttachments = await fileAttachmentsFromFiles(tenFiles);
check('file attachment reader caps incoming text files at eight', limitedAttachments.length === 8);
check('first eight files are read', tenFiles.slice(0, 8).every((file) => file.sliceRanges.length === 1));
check('files after the count limit are not read', tenFiles.slice(8).every((file) => file.sliceRanges.length === 0));

const existing: PendingFileAttachment[] = limitedAttachments.slice(0, 7);
const incoming: PendingFileAttachment[] = [
  { name: 'extra-a.txt', size: 1, type: 'text/plain', text: 'a', truncated: false },
  { name: 'extra-b.txt', size: 1, type: 'text/plain', text: 'b', truncated: false },
];
check('merge caps persisted attachments at eight', mergeFileAttachments(existing, incoming).length === 8);

console.log(`\nagent attachment harness: ${passed} assertions passed`);
