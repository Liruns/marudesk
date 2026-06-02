import { create } from 'zustand';

/**
 * App accent theme. marudesk's single violet accent token drives active states,
 * primary buttons, links, focus rings (--ring rides --accent) and the AI cues,
 * so swapping it via a `[data-accent]` attribute on <html> reskins the whole UI
 * at once — in both light and dark. The preset values live in styles/tokens.css;
 * this store just persists the choice and reflects it onto the document.
 */
export type AccentName = 'violet' | 'blue' | 'teal' | 'green' | 'amber' | 'rose';

export const ACCENTS: { name: AccentName; label: string; swatch: string }[] = [
  { name: 'violet', label: 'Violet', swatch: '#5E6AD2' },
  { name: 'blue', label: 'Blue', swatch: '#4C8DFF' },
  { name: 'teal', label: 'Teal', swatch: '#2DB8A8' },
  { name: 'green', label: 'Green', swatch: '#46B17F' },
  { name: 'amber', label: 'Amber', swatch: '#E0A03A' },
  { name: 'rose', label: 'Rose', swatch: '#E5618B' },
];

const STORAGE_KEY = 'marudesk.theme.accent';

function isAccent(v: unknown): v is AccentName {
  return typeof v === 'string' && ACCENTS.some((a) => a.name === v);
}

function loadAccent(): AccentName {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isAccent(v)) return v;
  } catch {
    // ignore — fall back to the default below
  }
  return 'violet';
}

/** Reflect the accent onto <html>; the default violet uses no attribute. */
function applyAccent(accent: AccentName): void {
  try {
    const el = document.documentElement;
    if (accent === 'violet') el.removeAttribute('data-accent');
    else el.setAttribute('data-accent', accent);
  } catch {
    // ignore — non-DOM context (e.g. tests)
  }
}

const initial = loadAccent();
// Apply at module load (before the first paint) so there's no accent flash.
applyAccent(initial);

type ThemeState = {
  accent: AccentName;
  setAccent: (accent: AccentName) => void;
};

export const useThemeStore = create<ThemeState>((set) => ({
  accent: initial,
  setAccent: (accent) => {
    try {
      localStorage.setItem(STORAGE_KEY, accent);
    } catch {
      // ignore — the in-memory value still updates
    }
    applyAccent(accent);
    set({ accent });
  },
}));
