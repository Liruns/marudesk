import {
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Globe, History } from 'lucide-react';
import type { HistoryEntry } from '../../../shared/history';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';

type HomeAddressSearchProps = {
  readonly onOpen: (url: string) => void;
};

export function HomeAddressSearch({ onOpen }: HomeAddressSearchProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<HistoryEntry[]>([]);
  const [highlight, setHighlight] = useState(-1);
  const latestQuery = useRef('');
  const searchLabel = t('home.search.placeholder');

  const onQueryChange = (value: string) => {
    setQuery(value);
    setHighlight(-1);
    latestQuery.current = value;
    const q = value.trim();
    if (!q) {
      setSuggestions([]);
      return;
    }
    void window.marudesk
      .invoke('history:query', q)
      .then((entries) => {
        if (latestQuery.current !== value) return;
        setSuggestions(entries.slice(0, 6));
      })
      .catch(() => setSuggestions([]));
  };

  const go = (value: string) => {
    const v = value.trim();
    if (!v) return;
    onOpen(v);
    setQuery('');
    setSuggestions([]);
    setHighlight(-1);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (highlight >= 0 && suggestions[highlight]) go(suggestions[highlight].url);
    else go(query);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (h + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (h <= 0 ? suggestions.length - 1 : h - 1));
    } else if (e.key === 'Escape') {
      setSuggestions([]);
      setHighlight(-1);
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      className="relative w-full max-w-xl animate-fade-rise [animation-delay:60ms]"
      role="search"
    >
      <div
        className={cn(
          'chrome-panel-strong h-11 w-full rounded-lg flex items-center pl-4 pr-2 gap-2',
          'focus-within:border-accent focus-within:shadow-focus-accent',
          'transition-[border-color,box-shadow] duration-fast',
        )}
      >
        <Globe size={16} className="text-fg-tertiary shrink-0" aria-hidden />
        <input
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          placeholder={searchLabel}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => window.setTimeout(() => setSuggestions([]), 120)}
          className={cn(
            'flex-1 min-w-0 bg-transparent text-body-sm text-fg-primary',
            'placeholder:text-fg-tertiary focus:outline-none',
          )}
          aria-label={searchLabel}
        />
      </div>
      {suggestions.length > 0 ? (
        <ul
          className="chrome-popover absolute left-0 right-0 top-12 z-20 overflow-hidden rounded-lg py-1"
          role="listbox"
        >
          {suggestions.map((s, i) => (
            <li key={s.url} role="option" aria-selected={i === highlight}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  go(s.url);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  'chrome-list-row w-full gap-2.5 px-3 py-1.5 text-left rounded-none',
                  i === highlight ? 'bg-surface-2 text-fg-primary' : '',
                )}
              >
                <History size={14} className="shrink-0 text-fg-tertiary" aria-hidden />
                {s.title ? (
                  <span className="shrink-0 max-w-[40%] truncate text-body-sm text-fg-secondary">
                    {s.title}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-caption text-fg-tertiary">
                  {s.url}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </form>
  );
}
