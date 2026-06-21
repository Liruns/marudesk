import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Search, FileText } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useWorkspaceStore } from '../workspace/store';
import { openFileInstrument } from '../work-graph/instrument';
import { fuzzyScore } from './fuzzy';
import { baseName, dirName } from '../git/statusMeta';
import { useI18n } from '../../i18n/useI18n';
import { Hint, PaletteHints, PaletteOverlay } from '../commands/PaletteOverlay';

/**
 * Command-palette quick-open (Ctrl+P). A centered, keyboard-first overlay that
 * fuzzy-matches the in-memory workspace file list (no disk read — reuses the
 * workspace store's file list) and opens the chosen file in the editor.
 *
 * Mirrors ModelPalette's overlay shell + keyboard model (↑↓/Enter/Esc, mount =
 * open so state starts fresh, highlight clamped on read).
 */
const MAX_RESULTS = 50;

export function QuickOpen({ onClose }: { onClose: () => void }) {
  const summary = useWorkspaceStore((s) => s.summary);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const { formatQuickOpenNoMatch, t } = useI18n();

  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  const results = useMemo(() => {
    const files = summary?.files ?? [];
    const q = query.trim();
    if (q === '') {
      // Empty query: show the first N files (alphabetical, as the store sorts).
      return files.slice(0, MAX_RESULTS).map((f) => ({ path: f.path, positions: [] as number[] }));
    }
    const scored: { path: string; score: number; positions: number[] }[] = [];
    for (const f of files) {
      const r = fuzzyScore(q, f.path);
      if (r) scored.push({ path: f.path, score: r.score, positions: r.positions });
    }
    scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return scored.slice(0, MAX_RESULTS);
  }, [summary, query]);

  const activeIndex = results.length === 0 ? 0 : Math.min(active, results.length - 1);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const choose = (path: string) => {
    void openFileInstrument(path);
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[activeIndex];
      if (r) choose(r.path);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <PaletteOverlay ariaLabel={t('quickOpen.dialogLabel')} onClose={onClose}>
        <div className="flex shrink-0 items-center gap-2 border-b border-subtle px-3 h-10">
          <Search size={15} className="shrink-0 text-fg-tertiary" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={
              summary
                ? t('quickOpen.placeholder.ready')
                : t('quickOpen.placeholder.noWorkspace')
            }
            spellCheck={false}
            autoComplete="off"
            disabled={!summary}
            className="flex-1 bg-transparent text-body-sm text-fg-primary placeholder:text-fg-tertiary focus:outline-none disabled:cursor-not-allowed"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {!summary ? (
            <div className="px-3 py-6 text-center text-caption text-fg-tertiary">
              {t('quickOpen.noWorkspace')}
            </div>
          ) : results.length === 0 ? (
            <div className="px-3 py-6 text-center text-caption text-fg-tertiary">
              {formatQuickOpenNoMatch(query)}
            </div>
          ) : (
            results.map((r, idx) => {
              const isActive = idx === activeIndex;
              const dir = dirName(r.path);
              return (
                <button
                  key={r.path}
                  ref={isActive ? activeRef : undefined}
                  type="button"
                  onClick={() => choose(r.path)}
                  onMouseEnter={() => setActive(idx)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-body-sm transition-colors',
                    isActive ? 'bg-surface-2 text-fg-primary' : 'text-fg-secondary',
                  )}
                >
                  <FileText size={14} className="shrink-0 text-fg-tertiary" />
                  <span className="shrink-0">
                    {highlight(baseName(r.path), basePositions(r.path, r.positions))}
                  </span>
                  {dir ? <span className="truncate text-caption text-fg-tertiary">{dir}</span> : null}
                </button>
              );
            })
          )}
        </div>

        <PaletteHints>
          <Hint k="↑↓" label={t('palette.hint.move')} />
          <Hint k="↵" label={t('quickOpen.hint.open')} />
          <Hint k="esc" label={t('palette.hint.close')} />
        </PaletteHints>
    </PaletteOverlay>
  );
}

/** Translate full-path match positions into basename-local positions. */
function basePositions(path: string, positions: number[]): number[] {
  const slash = path.lastIndexOf('/');
  if (slash < 0) return positions;
  const out: number[] = [];
  for (const p of positions) if (p > slash) out.push(p - slash - 1);
  return out;
}

/** Bold the matched characters in a label. */
function highlight(label: string, positions: number[]): ReactNode {
  if (positions.length === 0) return <span>{label}</span>;
  const set = new Set(positions);
  return (
    <span>
      {label.split('').map((ch, i) =>
        set.has(i) ? (
          <span key={i} className="text-accent font-medium">
            {ch}
          </span>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </span>
  );
}
