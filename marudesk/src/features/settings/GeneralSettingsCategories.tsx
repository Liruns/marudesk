import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  UI_ZOOM_MAX,
  UI_ZOOM_MIN,
  type CloseBehavior,
  type ThemeMode,
} from '../../../shared/settings';
import { MONO_FONT_PRESETS, UI_FONT_PRESETS } from '../../../shared/fonts';
import { LOCALE_OPTIONS } from '../../i18n/messages';
import { useI18n } from '../../i18n/useI18n';
import { AccentSwatches } from '../theme/AccentSwatches';
import { PaletteSwatches } from '../theme/PaletteSwatches';
import {
  Field,
  FontField,
  Section,
  Segmented,
  Stepper,
  TextField,
} from './SettingsControls';
import { SEARCH_ENGINE_OPTIONS } from './settingsOptions';
import { useDockOptions } from './useLocalizedSettingsOptions';
import { useSettingsStore } from './store';

function shellPlaceholder(): string {
  if (typeof navigator === 'undefined') return 'OS default';
  const ua = navigator.userAgent;
  if (ua.includes('Windows')) return 'Default (PowerShell)';
  if (ua.includes('Macintosh')) return 'Default (zsh)';
  return 'Default (bash)';
}

export function AppearanceCategory() {
  const { t, locale, setLocale } = useI18n();
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
  const languageOptions = LOCALE_OPTIONS.map((option) => ({
    value: option.value,
    label: option.nativeLabel,
  }));

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
        label={t('appearance.palette.label')}
        hint={t('settings.appearance.palette.hint')}
      >
        <PaletteSwatches variant="row" />
      </Field>
      <Field
        label={t('appearance.accent.label')}
        hint={t('settings.appearance.accent.hint')}
      >
        <AccentSwatches variant="row" />
      </Field>
      <Field
        label={t('appearance.language.label')}
        hint={t('settings.appearance.language.hint')}
      >
        <Segmented
          value={locale}
          options={languageOptions}
          onChange={(next) => setLocale(next)}
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
  const { t } = useI18n();
  const a = useSettingsStore((s) => s.settings.appearance);
  const update = useSettingsStore((s) => s.update);
  return (
    <Section>
      <Field
        label={t('settings.font.family.label')}
        hint={t('settings.font.family.hint')}
      >
        <FontField
          value={a.editorFontFamily}
          presets={MONO_FONT_PRESETS}
          onCommit={(editorFontFamily) =>
            void update({ appearance: { editorFontFamily } })
          }
        />
      </Field>
      <Field label={t('settings.font.size.label')}>
        <Stepper
          value={a.editorFontSize}
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={1}
          suffix="px"
          name={t('settings.font.size.label')}
          onChange={(editorFontSize) =>
            void update({ appearance: { editorFontSize } })
          }
        />
      </Field>
    </Section>
  );
}

export function TerminalCategory() {
  const { t } = useI18n();
  const settings = useSettingsStore((s) => s.settings);
  const a = settings.appearance;
  const update = useSettingsStore((s) => s.update);
  return (
    <Section>
      <Field
        label={t('settings.font.family.label')}
        hint={t('settings.font.family.hint')}
      >
        <FontField
          value={a.terminalFontFamily}
          presets={MONO_FONT_PRESETS}
          onCommit={(terminalFontFamily) =>
            void update({ appearance: { terminalFontFamily } })
          }
        />
      </Field>
      <Field label={t('settings.font.size.label')}>
        <Stepper
          value={a.terminalFontSize}
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={1}
          suffix="px"
          name={t('settings.font.size.label')}
          onChange={(terminalFontSize) =>
            void update({ appearance: { terminalFontSize } })
          }
        />
      </Field>
      <Field
        label={t('settings.terminal.shell.label')}
        hint={t('settings.terminal.shell.hint')}
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
  const { t } = useI18n();
  const browser = useSettingsStore((s) => s.settings.browser);
  const update = useSettingsStore((s) => s.update);
  return (
    <Section>
      <Field
        label={t('settings.browser.searchEngine.label')}
        hint={t('settings.browser.searchEngine.hint')}
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

export function WindowCategory() {
  const { t } = useI18n();
  const win = useSettingsStore((s) => s.settings.window);
  const update = useSettingsStore((s) => s.update);
  const options = [
    { value: 'tray', label: t('settings.window.closeBehavior.tray') },
    { value: 'quit', label: t('settings.window.closeBehavior.quit') },
  ] as const satisfies readonly {
    readonly value: CloseBehavior;
    readonly label: string;
  }[];
  return (
    <Section>
      <Field
        label={t('settings.window.closeBehavior.label')}
        hint={t('settings.window.closeBehavior.hint')}
      >
        <Segmented
          value={win.closeBehavior}
          options={options}
          onChange={(closeBehavior) => void update({ window: { closeBehavior } })}
        />
      </Field>
    </Section>
  );
}

export function DevtoolsCategory() {
  const { t } = useI18n();
  const dockOptions = useDockOptions();
  const devtools = useSettingsStore((s) => s.settings.devtools);
  const update = useSettingsStore((s) => s.update);
  return (
    <Section>
      <Field
        label={t('settings.devtools.dock.label')}
        hint={t('settings.devtools.dock.hint')}
      >
        <Segmented
          value={devtools.defaultDock}
          options={dockOptions}
          onChange={(defaultDock) => void update({ devtools: { defaultDock } })}
        />
      </Field>
    </Section>
  );
}
