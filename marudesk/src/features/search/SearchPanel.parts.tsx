import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { SearchFileResult, SearchMatchRange } from '../../../shared/search';
import { baseName, dirName } from '../git/statusMeta';

export function FileGroup({
  file,
  collapsed,
  formatSearchMatchLineTitle,
  onToggle,
  onOpenAt,
  t,
}: {
  file: SearchFileResult;
  collapsed: boolean;
  formatSearchMatchLineTitle: (line: number) => string;
  onToggle: () => void;
  onOpenAt: (line: number, col: number) => void;
  t: (key: 'search.expand' | 'search.collapse') => string;
}) {
  const dir = dirName(file.path);
  const first = file.matches[0];
  return (
    <div>
      <div className="group/file flex items-center h-6 pl-1 pr-2 hover:bg-surface-2">
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? t('search.expand') : t('search.collapse')}
          className="shrink-0 size-5 flex items-center justify-center text-fg-tertiary"
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
        <button
          type="button"
          onClick={() => first && onOpenAt(first.line, first.col)}
          title={file.path}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span className="truncate text-body-sm text-fg-primary">{baseName(file.path)}</span>
          {dir ? <span className="truncate text-caption text-fg-tertiary">{dir}</span> : null}
        </button>
        <span className="shrink-0 text-caption text-fg-tertiary tabular-nums">
          {file.matches.length}
        </span>
      </div>
      {!collapsed
        ? file.matches.map((m, i) => (
            <button
              key={`${m.line}:${m.col}:${i}`}
              type="button"
              onClick={() => onOpenAt(m.line, m.col)}
              title={formatSearchMatchLineTitle(m.line)}
              className="flex w-full items-baseline gap-2 py-0.5 pl-7 pr-2 text-left hover:bg-surface-2"
            >
              <span className="shrink-0 text-caption text-fg-tertiary tabular-nums w-8 text-right">
                {m.line}
              </span>
              <span className="truncate font-mono text-caption text-fg-secondary">
                <Highlight text={m.preview} ranges={m.ranges} />
              </span>
            </button>
          ))
        : null}
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
          className="rounded-sm bg-accent-subtle px-px text-accent"
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
