import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useWebPageStore } from './store';
import { useBrowserStrings } from './browserStrings';

export function BrowserFindBar() {
  const query = useWebPageStore((s) => s.findQuery);
  const matches = useWebPageStore((s) => s.findMatches);
  const activeMatch = useWebPageStore((s) => s.findActiveMatch);
  const focusNonce = useWebPageStore((s) => s.findFocusNonce);
  const setFindQuery = useWebPageStore((s) => s.setFindQuery);
  const findNext = useWebPageStore((s) => s.findNext);
  const closeFind = useWebPageStore((s) => s.closeFind);
  const inputRef = useRef<HTMLInputElement>(null);
  const { t } = useBrowserStrings();

  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, [focusNonce]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeFind();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      findNext(!e.shiftKey);
    }
  };

  const hasQuery = query.length > 0;
  return (
    <div className="shrink-0 px-3 py-1.5 flex items-center justify-end bg-surface-1 border-b border-subtle">
      <div className="flex items-center gap-1 h-8 rounded-md bg-surface-page border border-default pl-3 pr-1">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setFindQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('browser.find.placeholder')}
          spellCheck={false}
          autoComplete="off"
          aria-label={t('browser.find.aria')}
          className="w-48 bg-transparent text-body-sm text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
        />
        <span
          className="text-caption tabular-nums shrink-0 min-w-[3.5rem] text-right pr-1 text-fg-tertiary"
          aria-live="polite"
        >
          {hasQuery ? `${matches ? activeMatch : 0}/${matches}` : ''}
        </span>
        <span className="w-px h-4 bg-subtle shrink-0" aria-hidden />
        <FindBtn
          label={t('browser.find.previous')}
          disabled={!matches}
          onClick={() => findNext(false)}
        >
          <ChevronUp size={15} />
        </FindBtn>
        <FindBtn
          label={t('browser.find.next')}
          disabled={!matches}
          onClick={() => findNext(true)}
        >
          <ChevronDown size={15} />
        </FindBtn>
        <FindBtn label={t('browser.find.close')} onClick={closeFind}>
          <X size={14} />
        </FindBtn>
      </div>
    </div>
  );
}

function FindBtn({
  label,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'size-6 rounded flex items-center justify-center shrink-0 transition-colors duration-fast',
        disabled
          ? 'text-fg-tertiary opacity-40 cursor-not-allowed'
          : 'text-fg-secondary hover:bg-surface-2 hover:text-fg-primary',
      )}
    >
      {children}
    </button>
  );
}
