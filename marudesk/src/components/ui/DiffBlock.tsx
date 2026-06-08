import { useState } from 'react';
import { MessageSquarePlus, Pencil, Trash2 } from 'lucide-react';
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
  /**
   * Inline review comments keyed by line index (index into `lines`). When provided
   * together with {@link onCommentChange}, each addressable line gains a hover
   * affordance to add a comment, and existing comments render as rows beneath their
   * line (Codex / GitHub review-comment parity, v6 §U1). Omit both props for a
   * plain, non-interactive diff — existing callers are unaffected.
   */
  comments?: Readonly<Record<number, string>>;
  /** Add/update (text) or remove (null) the comment on a line index. */
  onCommentChange?: (lineIndex: number, text: string | null) => void;
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

export function DiffBlock({ filePath, lines, className, comments, onCommentChange }: DiffBlockProps) {
  const commenting = !!onCommentChange;
  // Which line index has an open comment editor, and its in-progress text. Kept
  // local: the saved comments live in the parent (controlled via onCommentChange).
  const [editing, setEditing] = useState<number | null>(null);
  const [text, setText] = useState('');

  const openEditor = (i: number, existing: string | undefined) => {
    setEditing(i);
    setText(existing ?? '');
  };
  const closeEditor = () => {
    setEditing(null);
    setText('');
  };
  const save = (i: number) => {
    onCommentChange?.(i, text.trim() ? text.trim() : null);
    closeEditor();
  };

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
        {lines.map((line, i) => {
          // Only lines that map to a real file line can carry a located comment
          // (skips the "… more lines" cap placeholder).
          const addressable = commenting && (line.oldLineNumber != null || line.newLineNumber != null);
          const comment = comments?.[i];
          return (
            <div key={i}>
              <div className={cn('group flex', ROW_BG[line.kind], ROW_BAR[line.kind])}>
                {commenting ? (
                  <span className="w-6 shrink-0 flex items-center justify-center select-none">
                    {addressable ? (
                      <button
                        type="button"
                        onClick={() => openEditor(i, comment)}
                        className="opacity-0 group-hover:opacity-100 text-fg-tertiary hover:text-accent transition-opacity duration-fast"
                        title="Comment on this line"
                        aria-label="Comment on this line"
                      >
                        <MessageSquarePlus size={12} />
                      </button>
                    ) : null}
                  </span>
                ) : null}
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
              {editing === i ? (
                <div className="flex flex-col gap-1.5 whitespace-normal bg-surface-2 border-y border-subtle px-3 py-2 font-sans">
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    autoFocus
                    rows={2}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        save(i);
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        closeEditor();
                      }
                    }}
                    placeholder="Leave a comment for the agent…"
                    className="w-full resize-y rounded bg-surface-page border border-default px-2 py-1.5 text-body-sm text-fg-primary focus:outline-none focus:border-accent"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => save(i)}
                      className="h-6 rounded bg-accent px-2 text-caption text-white hover:bg-accent-hover transition-colors duration-fast"
                    >
                      Comment
                    </button>
                    <button
                      type="button"
                      onClick={closeEditor}
                      className="h-6 rounded px-2 text-caption text-fg-tertiary hover:text-fg-secondary transition-colors duration-fast"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : comment ? (
                <div className="flex items-start gap-2 whitespace-normal bg-accent-subtle/20 border-y border-subtle px-3 py-1.5 font-sans">
                  <span className="min-w-0 flex-1 text-body-sm text-fg-secondary break-words">
                    {comment}
                  </span>
                  <button
                    type="button"
                    onClick={() => openEditor(i, comment)}
                    className="shrink-0 text-fg-tertiary hover:text-accent transition-colors duration-fast"
                    title="Edit comment"
                    aria-label="Edit comment"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onCommentChange?.(i, null)}
                    className="shrink-0 text-fg-tertiary hover:text-error transition-colors duration-fast"
                    title="Delete comment"
                    aria-label="Delete comment"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
