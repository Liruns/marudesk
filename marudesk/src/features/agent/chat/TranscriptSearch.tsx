import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useI18n } from '../../../i18n/useI18n';
import type { AgentMessage } from '../../../../shared/agent';
import { textOf } from './format';

/**
 * Floating transcript navigator (Ctrl/Cmd+F or the composer's search toggle).
 * With a query it walks the messages containing that text; with an EMPTY query
 * it walks the user's prompts — a fast way to hop between turns in a long
 * session. Jumps scroll the matched message into view and flash it. Newest-first
 * ergonomics: Enter starts at the most recent hit and walks older; Shift+Enter
 * (or the ↓ button) walks back toward newer.
 */
export function TranscriptSearch({
  messages,
  onClose,
}: {
  messages: AgentMessage[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  // -1 = "no jump yet": the first step lands on the most recent match.
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return messages.filter((m) => m.role === 'user' && textOf(m).trim()).map((m) => m.id);
    }
    return messages.filter((m) => textOf(m).toLowerCase().includes(q)).map((m) => m.id);
  }, [messages, query]);

  const index =
    matches.length === 0 ? -1 : active < 0 ? matches.length - 1 : Math.min(active, matches.length - 1);

  const jump = (i: number) => {
    const id = matches[i];
    if (id === undefined) return;
    setActive(i);
    const el = document.getElementById(`agent-msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    // Restart the flash even when re-jumping to the same message.
    el.classList.remove('msg-flash');
    void el.offsetWidth;
    el.classList.add('msg-flash');
    window.setTimeout(() => el.classList.remove('msg-flash'), 1300);
  };

  const older = () => jump(active < 0 ? matches.length - 1 : Math.max(0, index - 1));
  const newer = () => jump(Math.min(matches.length - 1, index + 1));

  return (
    <div className="absolute right-2 top-2 z-20 flex items-center gap-1 rounded-md border border-default bg-surface-2 px-1.5 py-1 shadow-lifted">
      <Search size={12} className="shrink-0 text-fg-tertiary" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(-1);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) newer();
            else older();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder={t('agent.chat.search.placeholder')}
        aria-label={t('agent.chat.search.placeholder')}
        spellCheck={false}
        className="w-36 bg-transparent text-caption text-fg-primary placeholder:text-fg-tertiary focus:outline-none"
      />
      <span className="shrink-0 text-caption tabular-nums text-fg-tertiary">
        {matches.length === 0 ? t('agent.chat.search.none') : `${index + 1}/${matches.length}`}
      </span>
      <button
        type="button"
        onClick={older}
        disabled={matches.length === 0 || index === 0}
        aria-label={t('agent.chat.search.older')}
        title={t('agent.chat.search.older')}
        className="chrome-icon-button size-5 disabled:opacity-40"
      >
        <ChevronUp size={12} />
      </button>
      <button
        type="button"
        onClick={newer}
        disabled={matches.length === 0 || index >= matches.length - 1}
        aria-label={t('agent.chat.search.newer')}
        title={t('agent.chat.search.newer')}
        className="chrome-icon-button size-5 disabled:opacity-40"
      >
        <ChevronDown size={12} />
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={t('agent.chat.search.close')}
        title={t('agent.chat.search.close')}
        className="chrome-icon-button size-5"
      >
        <X size={12} />
      </button>
    </div>
  );
}
