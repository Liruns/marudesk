import { useState, type ComponentType, type ReactNode } from 'react';
import {
  Code2,
  Globe,
  Info,
  KeyRound,
  Palette,
  RotateCcw,
  SquareTerminal,
  Wrench,
} from 'lucide-react';
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  UI_ZOOM_MAX,
  UI_ZOOM_MIN,
  type DevtoolsDock,
  type SearchEngine,
  type ThemeMode,
} from '../../../shared/settings';
import { cn } from '../../lib/cn';
import { useSettingsStore, type SettingsCategory } from './store';
import { ProvidersSettings } from './ProvidersSettings';

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' },
];

const DOCK_OPTIONS: { value: DevtoolsDock; label: string }[] = [
  { value: 'right', label: 'Right' },
  { value: 'bottom', label: 'Bottom' },
  { value: 'chrome', label: 'Chrome' },
];

const SEARCH_ENGINE_OPTIONS: { value: SearchEngine; label: string }[] = [
  { value: 'google', label: 'Google' },
  { value: 'duckduckgo', label: 'DuckDuckGo' },
  { value: 'bing', label: 'Bing' },
];

const CATEGORIES: {
  id: SettingsCategory;
  label: string;
  icon: ComponentType<{ size?: number }>;
  blurb: string;
}[] = [
  { id: 'appearance', label: 'Appearance', icon: Palette, blurb: 'Theme, interface zoom, and UI font.' },
  { id: 'editor', label: 'Editor', icon: Code2, blurb: 'Code editor font and size.' },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal, blurb: 'Integrated terminal font and shell.' },
  { id: 'browser', label: 'Browser', icon: Globe, blurb: 'Search engine and embedded-browser behavior.' },
  { id: 'providers', label: 'AI Providers', icon: KeyRound, blurb: 'Provider API keys + custom OpenAI-compatible endpoints. Pick the model in the chat.' },
  { id: 'devtools', label: 'Browser DevTools', icon: Wrench, blurb: 'How the embedded browser DevTools opens.' },
  { id: 'about', label: 'About', icon: Info, blurb: 'Version and runtime details.' },
];

function shellPlaceholder(): string {
  if (typeof navigator === 'undefined') return 'OS default';
  const ua = navigator.userAgent;
  if (ua.includes('Windows')) return 'Default (PowerShell)';
  if (ua.includes('Macintosh')) return 'Default (zsh)';
  return 'Default (bash)';
}

/**
 * The Settings surface, rendered inside a `settings` tab. A VSCode-style left
 * category rail switches the detail panel; every control writes straight
 * through to the persisted store, so there's no save button — changes apply and
 * persist immediately. The AI Providers category (formerly a separate modal) now
 * lives here too, so Settings is the single place for all app configuration.
 */
export function SettingsView() {
  const category = useSettingsStore((s) => s.category);
  const setCategory = useSettingsStore((s) => s.setCategory);
  const active = CATEGORIES.find((c) => c.id === category) ?? CATEGORIES[0];

  return (
    <div className="flex-1 min-h-0 flex bg-surface-page">
      <aside className="w-52 shrink-0 flex flex-col border-r border-subtle bg-surface-1">
        <header className="h-11 shrink-0 flex items-center px-4 border-b border-subtle">
          <h1 className="text-body font-medium text-fg-primary">Settings</h1>
        </header>
        <nav
          aria-label="Settings categories"
          className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-0.5"
        >
          {CATEGORIES.map((c) => (
            <NavItem
              key={c.id}
              active={c.id === category}
              onClick={() => setCategory(c.id)}
              icon={<c.icon size={15} />}
              label={c.label}
            />
          ))}
        </nav>
      </aside>

      <div className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-2xl px-8 py-8 flex flex-col gap-6">
          <header className="flex flex-col gap-1">
            <h2 className="text-section text-fg-primary">{active.label}</h2>
            <p className="text-body-sm text-fg-tertiary">{active.blurb}</p>
          </header>
          {category === 'appearance' ? <AppearanceCategory /> : null}
          {category === 'editor' ? <EditorCategory /> : null}
          {category === 'terminal' ? <TerminalCategory /> : null}
          {category === 'browser' ? <BrowserCategory /> : null}
          {category === 'providers' ? <ProvidersSettings /> : null}
          {category === 'devtools' ? <DevtoolsCategory /> : null}
          {category === 'about' ? <AboutCategory /> : null}
        </div>
      </div>
    </div>
  );
}

function AppearanceCategory() {
  const a = useSettingsStore((s) => s.settings.appearance);
  const update = useSettingsStore((s) => s.update);
  return (
    <Section>
      <Field label="Theme" hint="Follow the OS, or force light/dark.">
        <Segmented
          value={a.theme}
          options={THEME_OPTIONS}
          onChange={(theme) => void update({ appearance: { theme } })}
        />
      </Field>
      <Field label="Interface zoom" hint="Scales the whole UI.">
        <Stepper
          value={a.uiZoom}
          min={UI_ZOOM_MIN}
          max={UI_ZOOM_MAX}
          step={10}
          suffix="%"
          name="Interface zoom"
          onChange={(uiZoom) => void update({ appearance: { uiZoom } })}
        />
      </Field>
      <Field label="UI font" hint="Empty uses the bundled Inter stack.">
        <TextField
          value={a.uiFontFamily}
          placeholder="Default (Inter)"
          onCommit={(uiFontFamily) => void update({ appearance: { uiFontFamily } })}
        />
      </Field>
    </Section>
  );
}

function EditorCategory() {
  const a = useSettingsStore((s) => s.settings.appearance);
  const update = useSettingsStore((s) => s.update);
  return (
    <Section>
      <Field label="Font family">
        <TextField
          value={a.editorFontFamily}
          placeholder="Default (JetBrains Mono)"
          onCommit={(editorFontFamily) =>
            void update({ appearance: { editorFontFamily } })
          }
        />
      </Field>
      <Field label="Font size">
        <Stepper
          value={a.editorFontSize}
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={1}
          suffix="px"
          name="editor font size"
          onChange={(editorFontSize) =>
            void update({ appearance: { editorFontSize } })
          }
        />
      </Field>
    </Section>
  );
}

function TerminalCategory() {
  const settings = useSettingsStore((s) => s.settings);
  const a = settings.appearance;
  const update = useSettingsStore((s) => s.update);
  return (
    <Section>
      <Field label="Font family">
        <TextField
          value={a.terminalFontFamily}
          placeholder="Default (JetBrains Mono)"
          onCommit={(terminalFontFamily) =>
            void update({ appearance: { terminalFontFamily } })
          }
        />
      </Field>
      <Field label="Font size">
        <Stepper
          value={a.terminalFontSize}
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={1}
          suffix="px"
          name="terminal font size"
          onChange={(terminalFontSize) =>
            void update({ appearance: { terminalFontSize } })
          }
        />
      </Field>
      <Field
        label="Default shell"
        hint="Path or command. Used by the integrated terminal."
      >
        <TextField
          value={settings.terminal.defaultShell}
          placeholder={shellPlaceholder()}
          onCommit={(defaultShell) => void update({ terminal: { defaultShell } })}
        />
      </Field>
    </Section>
  );
}

function BrowserCategory() {
  const browser = useSettingsStore((s) => s.settings.browser);
  const update = useSettingsStore((s) => s.update);
  return (
    <Section>
      <Field
        label="Search engine"
        hint="Used when the address bar input isn't a URL."
      >
        <Segmented
          value={browser.searchEngine}
          options={SEARCH_ENGINE_OPTIONS}
          onChange={(searchEngine) => void update({ browser: { searchEngine } })}
        />
      </Field>
    </Section>
  );
}

function DevtoolsCategory() {
  const devtools = useSettingsStore((s) => s.settings.devtools);
  const update = useSettingsStore((s) => s.update);
  return (
    <Section>
      <Field
        label="Open as"
        hint="Right/Bottom dock our own inspector; Chrome opens the built-in DevTools window (for emulation, throttling, and the debugger)."
      >
        <Segmented
          value={devtools.defaultDock}
          options={DOCK_OPTIONS}
          onChange={(defaultDock) => void update({ devtools: { defaultDock } })}
        />
      </Field>
    </Section>
  );
}

function AboutCategory() {
  const reset = useSettingsStore((s) => s.reset);
  return (
    <Section>
      <Field label="Version">
        <span className="text-body-sm font-mono text-fg-secondary">0.1.0 (MVP)</span>
      </Field>
      <Field label="Runtime">
        <span className="text-body-sm font-mono text-fg-secondary">
          Electron · React · TypeScript
        </span>
      </Field>
      <Field label="Security" hint="contextIsolation · sandboxed renderer · safeStorage keys">
        <span className="text-caption text-fg-tertiary">Hardened</span>
      </Field>
      <Field
        label="Reset settings"
        hint="Restore every setting on this screen to its default."
      >
        <button
          type="button"
          onClick={() => {
            if (
              window.confirm('Reset all settings to their defaults?')
            ) {
              void reset();
            }
          }}
          className={cn(
            'inline-flex items-center gap-1.5 h-8 px-3 rounded-md',
            'text-body-sm text-fg-secondary bg-surface-2',
            'hover:text-fg-primary hover:bg-surface-3 transition-colors duration-fast',
          )}
        >
          <RotateCcw size={14} />
          Reset to defaults
        </button>
      </Field>
    </Section>
  );
}

function NavItem({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'h-8 rounded-md px-2.5 flex items-center gap-2 text-body-sm text-left',
        'transition-colors duration-fast',
        active
          ? 'bg-accent-subtle/40 text-fg-primary'
          : 'text-fg-secondary hover:bg-surface-2 hover:text-fg-primary',
      )}
    >
      <span className={active ? 'text-accent' : 'text-fg-tertiary'} aria-hidden>
        {icon}
      </span>
      <span>{label}</span>
    </button>
  );
}

function Section({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col rounded-lg border border-subtle bg-surface-1 divide-y divide-subtle">
      {children}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-body-sm text-fg-primary">{label}</span>
        {hint ? (
          <span className="text-caption text-fg-tertiary">{hint}</span>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      className="inline-flex rounded-md bg-surface-2 p-0.5 gap-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'px-3 h-7 rounded text-body-sm transition-colors duration-fast',
            value === o.value
              ? 'bg-surface-page text-fg-primary'
              : 'text-fg-tertiary hover:text-fg-secondary',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const STEP_BTN = cn(
  'size-7 rounded flex items-center justify-center shrink-0',
  'text-fg-secondary hover:text-fg-primary hover:bg-surface-2',
  'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent',
  'transition-colors duration-fast',
);

function Stepper({
  value,
  min,
  max,
  step,
  suffix,
  name,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  /** What this stepper adjusts — used in the +/- button labels (a11y + scoping). */
  name: string;
  onChange: (value: number) => void;
}) {
  const set = (v: number) => onChange(Math.min(max, Math.max(min, v)));
  return (
    <div className="inline-flex items-center gap-1 rounded-md bg-surface-2 p-0.5">
      <button
        type="button"
        aria-label={`Decrease ${name}`}
        disabled={value <= min}
        onClick={() => set(value - step)}
        className={STEP_BTN}
      >
        <Minus />
      </button>
      <span className="min-w-[56px] text-center text-body-sm text-fg-primary tabular-nums">
        {value}
        {suffix}
      </span>
      <button
        type="button"
        aria-label={`Increase ${name}`}
        disabled={value >= max}
        onClick={() => set(value + step)}
        className={STEP_BTN}
      >
        <Plus />
      </button>
    </div>
  );
}

function TextField({
  value,
  placeholder,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [local, setLocal] = useState(value);
  // Reset the draft when the committed value changes upstream, using the
  // store-previous-prop pattern (no effect → no cascading render).
  const [committed, setCommitted] = useState(value);
  if (value !== committed) {
    setCommitted(value);
    setLocal(value);
  }
  const commit = () => {
    if (local !== value) onCommit(local);
  };
  return (
    <input
      type="text"
      value={local}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setLocal(value);
          e.currentTarget.blur();
        }
      }}
      className={cn(
        'h-8 w-[240px] max-w-[40vw] rounded-md bg-surface-page border border-default px-3',
        'text-body-sm text-fg-primary placeholder:text-fg-tertiary',
        'focus:outline-none focus:border-accent transition-colors duration-fast',
      )}
    />
  );
}

// Tiny inline glyphs (avoid pulling icon components into a settings-only file).
function Minus() {
  return <span aria-hidden className="block h-px w-2.5 bg-current" />;
}
function Plus() {
  return (
    <span aria-hidden className="relative block size-2.5">
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-current" />
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-current" />
    </span>
  );
}
