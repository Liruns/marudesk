import { cn } from '../../lib/cn';

export type DiffLine = {
  kind: 'add' | 'remove' | 'context';
  oldLineNumber?: number;
  newLineNumber?: number;
  content: string;
};

export type DiffBlockProps = {
  filePath: string;
  lines: DiffLine[];
  className?: string;
};

const ROW_BG: Record<DiffLine['kind'], string> = {
  add: 'bg-diff-add',
  remove: 'bg-diff-remove',
  context: '',
};

const ROW_BAR: Record<DiffLine['kind'], string> = {
  add: 'border-l-2 border-l-success',
  remove: 'border-l-2 border-l-error',
  context: 'border-l-2 border-l-transparent',
};

const ROW_PREFIX: Record<DiffLine['kind'], string> = {
  add: '+',
  remove: '-',
  context: ' ',
};

export function DiffBlock({ filePath, lines, className }: DiffBlockProps) {
  return (
    <div
      className={cn(
        'rounded border border-subtle overflow-hidden bg-surface-1',
        className,
      )}
    >
      <div className="bg-surface-2 border-b border-subtle px-3 py-2 font-mono text-body-sm text-fg-secondary tabular-nums">
        {filePath}
      </div>
      <pre className="font-mono text-body-sm leading-[1.55] m-0">
        {lines.map((line, i) => (
          <div key={i} className={cn('flex', ROW_BG[line.kind], ROW_BAR[line.kind])}>
            <span className="w-10 px-2 text-right text-fg-tertiary tabular-nums shrink-0 select-none">
              {line.oldLineNumber ?? ''}
            </span>
            <span className="w-10 px-2 text-right text-fg-tertiary tabular-nums shrink-0 select-none">
              {line.newLineNumber ?? ''}
            </span>
            <span className="w-4 text-center text-fg-tertiary shrink-0 select-none">
              {ROW_PREFIX[line.kind]}
            </span>
            <span className="text-fg-primary whitespace-pre">{line.content}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
