import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type { Suggestion } from '../../../shared/suggest';

/**
 * State machine for the address-bar dropdown. The list comes from
 * `browser:suggest` (bookmarks above history by frecency, plus a trailing
 * "search the web" row); fetches are debounced and stale responses dropped.
 * Rendering lives in AddressSuggestions.tsx (split per react-refresh).
 */

const DEBOUNCE_MS = 80;

export type AddressSuggestState = {
  suggestions: Suggestion[];
  /** The typed text the current suggestions answer (drives highlighting). */
  query: string;
  selected: number;
  setSelected: (index: number) => void;
  /** Feed every address-bar input change here (debounced internally). */
  onInput: (value: string) => void;
  /** Returns true when the key was consumed (caller should do nothing else). */
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => boolean;
  accept: (s: Suggestion) => void;
  close: () => void;
};

export function useAddressSuggestions(
  onAccept: (s: Suggestion) => void,
): AddressSuggestState {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(-1);
  const timer = useRef<number | null>(null);
  const latest = useRef('');

  const close = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    latest.current = '';
    setSuggestions([]);
    setSelected(-1);
  }, []);

  const onInput = useCallback(
    (value: string) => {
      latest.current = value;
      if (timer.current !== null) window.clearTimeout(timer.current);
      if (!value.trim()) {
        close();
        return;
      }
      timer.current = window.setTimeout(() => {
        timer.current = null;
        void window.marudesk
          .invoke('browser:suggest', value)
          .then((rows) => {
            // Drop a stale result: the user kept typing (or cleared the bar).
            if (latest.current !== value) return;
            setQuery(value);
            setSuggestions(rows);
            setSelected(-1);
          })
          .catch(() => undefined);
      }, DEBOUNCE_MS);
    },
    [close],
  );

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const accept = useCallback(
    (s: Suggestion) => {
      close();
      onAccept(s);
    },
    [close, onAccept],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): boolean => {
    if (suggestions.length === 0) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((i) => (i + 1) % suggestions.length);
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return true;
    }
    if (e.key === 'Enter' && selected >= 0) {
      const s = suggestions[selected];
      if (s) {
        // Consume the Enter so the form's default submit doesn't double-fire.
        e.preventDefault();
        accept(s);
        return true;
      }
    }
    return false;
  };

  return {
    suggestions,
    query,
    selected,
    setSelected,
    onInput,
    onKeyDown,
    accept,
    close,
  };
}
