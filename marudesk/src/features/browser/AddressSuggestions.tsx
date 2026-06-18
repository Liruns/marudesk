import type { ReactNode } from 'react';
import { ArrowRight, History, Search, Star } from 'lucide-react';
import { matchRanges, type Suggestion } from '../../../shared/suggest';
import { stripUrlPrefix } from '../../../shared/history';
import { cn } from '../../lib/cn';
import { useBrowserStrings } from './browserStrings';
import type { AddressSuggestState } from './useAddressSuggestions';

/**
 * Address-bar dropdown suggestions (state machine: useAddressSuggestions.ts).
 *
 * The panel renders as a chrome row BELOW the toolbar (a flex sibling, like the
 * find bar) — it cannot overlay the stage because the WebContentsView paints
 * above the React DOM; the stage's ResizeObserver shrinks the web view under it.
 */
export function AddressSuggestionsPanel({
  state,
}: {
  readonly state: AddressSuggestState;
}) {
  const { t } = useBrowserStrings();
  const { suggestions, query, selected, setSelected, accept } = state;
  if (suggestions.length === 0) return null;

  return (
    <div
      className="shrink-0 bg-surface-1 border-b border-subtle py-1"
      role="listbox"
      aria-label={t('browser.suggest.aria')}
    >
      {suggestions.map((s, i) => (
        <button
          key={`${s.kind}:${s.url}`}
          type="button"
          role="option"
          aria-selected={i === selected}
          // mousedown (not click) so the address bar never loses focus first.
          onMouseDown={(e) => {
            e.preventDefault();
            accept(s);
          }}
          onMouseEnter={() => setSelected(i)}
          className={cn(
            'w-full flex items-center gap-2.5 px-3.5 py-1.5 text-left transition-colors duration-fast',
            i === selected ? 'bg-surface-2 text-fg-primary' : 'text-fg-secondary',
          )}
        >
          <SuggestionIcon kind={s.kind} />
          {s.kind === 'search' ? (
            <span className="min-w-0 flex-1 truncate text-body-sm text-fg-primary">
              {t('browser.suggest.searchBefore')}
              <span className="text-accent">{s.title}</span>
              {t('browser.suggest.searchAfter')}
            </span>
          ) : s.kind === 'go' ? (
            <span className="min-w-0 flex-1 truncate text-body-sm text-fg-secondary">
              {t('browser.suggest.goTo')}
              <span className="text-fg-primary">{stripUrlPrefix(s.url)}</span>
            </span>
          ) : (
            <>
              {s.title ? (
                <HighlightedText
                  text={s.title}
                  query={query}
                  className="shrink-0 max-w-[40%] truncate text-body-sm text-fg-primary"
                />
              ) : null}
              <HighlightedText
                text={stripUrlPrefix(s.url)}
                query={query}
                className="min-w-0 flex-1 truncate text-caption text-fg-tertiary"
              />
            </>
          )}
        </button>
      ))}
    </div>
  );
}

function SuggestionIcon({ kind }: { readonly kind: Suggestion['kind'] }) {
  const className = 'shrink-0 text-fg-tertiary';
  if (kind === 'bookmark') {
    return <Star size={14} className={cn(className, 'text-accent')} aria-hidden />;
  }
  if (kind === 'go') return <ArrowRight size={14} className={className} aria-hidden />;
  if (kind === 'search') return <Search size={14} className={className} aria-hidden />;
  return <History size={14} className={className} aria-hidden />;
}

/** Renders `text` with the query's matched token spans in the accent color. */
function HighlightedText({
  text,
  query,
  className,
}: {
  readonly text: string;
  readonly query: string;
  readonly className?: string;
}) {
  const ranges = matchRanges(text, query);
  if (ranges.length === 0) return <span className={className}>{text}</span>;
  const parts: ReactNode[] = [];
  let pos = 0;
  for (const r of ranges) {
    if (r.start > pos) parts.push(text.slice(pos, r.start));
    parts.push(
      <span key={r.start} className="text-accent">
        {text.slice(r.start, r.end)}
      </span>,
    );
    pos = r.end;
  }
  if (pos < text.length) parts.push(text.slice(pos));
  return <span className={className}>{parts}</span>;
}
