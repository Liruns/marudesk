import { Badge, DiffBlock, type DiffLine } from '../../components/ui';
import type { PatchOpPreview, PatchPreview } from '../../../shared/patch';

function diffForEdit(
  preview: Extract<PatchOpPreview, { kind: 'edit' }>,
): DiffLine[] {
  const oldLines = preview.oldString.split('\n');
  const newLines = preview.newString.split('\n');
  const lines: DiffLine[] = [];
  oldLines.forEach((content, i) => {
    lines.push({
      kind: 'remove',
      oldLineNumber: preview.startLine + i,
      content,
    });
  });
  newLines.forEach((content, i) => {
    lines.push({
      kind: 'add',
      newLineNumber: preview.startLine + i,
      content,
    });
  });
  return lines;
}

function diffForCreate(
  preview: Extract<PatchOpPreview, { kind: 'create' }>,
): DiffLine[] {
  return preview.newString.split('\n').map((content, i) => ({
    kind: 'add' as const,
    newLineNumber: i + 1,
    content,
  }));
}

type OpProps = { op: PatchOpPreview };

function OpCard({ op }: OpProps) {
  const variant =
    op.kind === 'error'
      ? 'error'
      : op.kind === 'create'
        ? 'accent'
        : 'neutral';
  return (
    <article className="flex flex-col gap-2">
      <header className="flex items-center gap-2 min-w-0">
        <Badge variant={variant}>{op.kind}</Badge>
        <span
          className="font-mono text-body-sm text-fg-secondary truncate min-w-0"
          title={op.path}
        >
          {op.path}
        </span>
      </header>
      {op.kind === 'error' ? (
        <div className="rounded border border-error/40 bg-error-subtle/40 px-3 py-2 text-body-sm text-fg-secondary break-words">
          {op.reason}
        </div>
      ) : op.kind === 'edit' ? (
        <DiffBlock filePath={op.path} lines={diffForEdit(op)} />
      ) : (
        <DiffBlock filePath={`${op.path} (new file)`} lines={diffForCreate(op)} />
      )}
    </article>
  );
}

export function PatchPreviewView({ preview }: { preview: PatchPreview }) {
  if (preview.ops.length === 0) {
    return (
      <div className="text-body-sm text-fg-tertiary">
        Preview returned no ops.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {preview.ops.map((op, i) => (
        <OpCard key={i} op={op} />
      ))}
    </div>
  );
}
