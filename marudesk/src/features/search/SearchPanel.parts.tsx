import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, FileText, ListPlus } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { SearchFileResult, SearchMatchRange } from '../../../shared/search';
import { baseName, dirName } from '../git/statusMeta';

export function FileGroup({
  file,
  collapsed,
  formatSearchMatchLineTitle,
  onToggle,
  onOpenAt,
  onCreateTask,
  t,
}: {
  file: SearchFileResult;
  collapsed: boolean;
  formatSearchMatchLineTitle: (line: number) => string;
  onToggle: () => void;
  onOpenAt: (line: number, col: number) => void;
  onCreateTask: (line: number, preview: string) => void;
  t: (key: 'search.expand' | 'search.collapse' | 'search.createTask') => string;
}) {
  const dir = dirName(file.path);
  const first = file.matches[0];
  return (
    <div className="select-none">
      {/* File header — sticks to the top of the scroll area so the path stays
          visible while paging through its matches (VS Code parity). */}
      <div className="group/file sticky top-0 z-[1] flex h-7 items-center gap-0.5 border-b border-subtle/40 bg-surface-1/95 pl-1 pr-1.5 backdrop-blur-sm hover:bg-surface-2">
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? t('search.expand') : t('search.collapse')}
          className="flex size-5 shrink-0 items-center justify-center rounded text-fg-tertiary transition-colors duration-fast hover:text-fg-primary"
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
        <button
          type="button"
          onClick={() => first && onOpenAt(first.line, first.col)}
          title={file.path}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <FileText size={13} className="shrink-0 text-fg-tertiary/70" />
          <span className="truncate text-body-sm font-medium text-fg-primary">
            {baseName(file.path)}
          </span>
          {dir ? (
            <span className="truncate text-caption text-fg-tertiary/80">{dir}</span>
          ) : null}
        </button>
        <span className="shrink-0 rounded-pill bg-surface-3 px-1.5 text-[0.6875rem] font-medium tabular-nums text-fg-secondary">
          {file.matches.length}
        </span>
      </div>
      {!collapsed ? (
        <div className="relative pb-0.5">
          {/* Guide line tying a file's matches to its header. */}
          <span
            aria-hidden
            className="pointer-events-none absolute bottom-1 left-[1.15rem] top-0 w-px bg-subtle"
          />
          {file.matches.map((m, i) => (
            <div
              key={`${m.line}:${m.col}:${i}`}
              className="group/match relative flex items-stretch rounded-sm transition-colors duration-fast hover:bg-accent-subtle/40"
            >
              <button
                type="button"
                onClick={() => onOpenAt(m.line, m.col)}
                title={formatSearchMatchLineTitle(m.line)}
                className="flex min-w-0 flex-1 items-baseline gap-2.5 py-[3px] pl-7 pr-7 text-left"
              >
                <span className="w-9 shrink-0 text-right text-caption tabular-nums text-fg-tertiary/70 group-hover/match:text-fg-secondary">
                  {m.line}
                </span>
                <span className="truncate font-mono text-caption leading-relaxed text-fg-secondary group-hover/match:text-fg-primary">
                  <Highlight text={m.preview} ranges={m.ranges} />
                </span>
              </button>
              {/* Secondary action: promote the match to a tracked task. Sits on top
                  of the row, surfacing on hover/focus; never intercepts the row's
                  primary open-file click. */}
              <button
                type="button"
                onClick={() => onCreateTask(m.line, m.preview)}
                aria-label={t('search.createTask')}
                title={t('search.createTask')}
                className="absolute right-1 top-1/2 size-5 -translate-y-1/2 items-center justify-center rounded text-fg-tertiary opacity-0 transition-opacity duration-fast hover:bg-surface-3 hover:text-fg-primary focus-visible:opacity-100 group-hover/match:opacity-100 flex"
              >
                <ListPlus size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Render preview text with each match span wrapped for highlight. */
function Highlight({
  text,
  ranges,
}: {
  text: string;
  ranges: SearchMatchRange[];
}) {
  if (ranges.length === 0) return <>{text}</>;
  const out: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((r, i) => {
    const start = Math.max(cursor, r.start);
    if (start > cursor) out.push(text.slice(cursor, start));
    const end = Math.max(start, r.end);
    if (end > start) {
      out.push(
        <mark
          key={`m${i}`}
          className="rounded-[3px] bg-accent/25 px-0.5 font-medium text-fg-primary"
        >
          {text.slice(start, end)}
        </mark>,
      );
    }
    cursor = Math.max(cursor, end);
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return <>{out}</>;
}

export function Toggle({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        'shrink-0 size-6 rounded flex items-center justify-center transition-colors duration-fast',
        active
          ? 'bg-accent-subtle/40 text-accent'
          : 'text-fg-tertiary hover:text-fg-primary hover:bg-surface-3',
      )}
    >
      {children}
    </button>
  );
}
