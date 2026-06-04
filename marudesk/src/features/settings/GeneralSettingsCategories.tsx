import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  UI_ZOOM_MAX,
  UI_ZOOM_MIN,
  type ThemeMode,
} from '../../../shared/settings';
import { MONO_FONT_PRESETS, UI_FONT_PRESETS } from '../../../shared/fonts';
import { useI18n } from '../../i18n/useI18n';
import {
  Field,
  FontField,
  Section,
  Segmented,
  Stepper,
  TextField,
} from './SettingsControls';
import { DOCK_OPTIONS, SEARCH_ENGINE_OPTIONS } from './settingsOptions';
import { useSettingsStore } from './store';

function shellPlaceholder(): string {
  if (typeof navigator === 'undefined') return 'OS default';
  const ua = navigator.userAgent;
  if (ua.includes('Windows')) return 'Default (PowerShell)';
  if (ua.includes('Macintosh')) return 'Default (zsh)';
  return 'Default (bash)';
}

export function AppearanceCategory() {
  const { t } = useI18n();
  const a = useSettingsStore((s) => s.settings.appearance);
  const update = useSettingsStore((s) => s.update);
  const themeOptions = [
    { value: 'dark', label: t('appearance.mode.dark') },
    { value: 'light', label: t('appearance.mode.light') },
    { value: 'system', label: t('appearance.mode.system') },
  ] as const satisfies readonly {
    readonly value: ThemeMode;
    readonly label: string;
  }[];

  return (
    <Section>
      <Field
        label={t('settings.appearance.theme.label')}
        hint={t('settings.appearance.theme.hint')}
      >
        <Segmented
          value={a.theme}
          options={themeOptions}
          onChange={(theme) => void update({ appearance: { theme } })}
        />
      </Field>
      <Field
        label={t('settings.appearance.uiZoom.label')}
        hint={t('settings.appearance.uiZoom.hint')}
      >
        <Stepper
          value={a.uiZoom}
          min={UI_ZOOM_MIN}
          max={UI_ZOOM_MAX}
          step={10}
          suffix="%"
          name={t('settings.appearance.uiZoom.label')}
          onChange={(uiZoom) => void update({ appearance: { uiZoom } })}
        />
      </Field>
      <Field
        label={t('settings.appearance.uiFont.label')}
        hint={t('settings.appearance.uiFont.hint')}
      >
        <FontField
          value={a.uiFontFamily}
          presets={UI_FONT_PRESETS}
          onCommit={(uiFontFamily) => void update({ appearance: { uiFontFamily } })}
        />
      </Field>
    </Section>
  );
}

export function EditorCategory() {
  const a = useSettingsStore((s) => s.settings.appearance);
  const update = useSettingsStore((s) => s.update);
  return (
    <Section>
      <Field label="Font family" hint="Falls back to JetBrains Mono if unavailable.">
        <FontField
          value={a.editorFontFamily}
          presets={MONO_FONT_PRESETS}
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

export function TerminalCategory() {
  const settings = useSettingsStore((s) => s.settings);
  const a = settings.appearance;
  const update = useSettingsStore((s) => s.update);
  return (
    <Section>
      <Field label="Font family" hint="Falls back to JetBrains Mono if unavailable.">
        <FontField
          value={a.terminalFontFamily}
          presets={MONO_FONT_PRESETS}
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
        hint="Path or command for the integrated terminal. Leave blank for the OS default; an unknown shell falls back automatically."
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

export function BrowserCategory() {
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

export function DevtoolsCategory() {
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
