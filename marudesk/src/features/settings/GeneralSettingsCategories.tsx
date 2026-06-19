import { useEffect, useState } from 'react';
import { SquareTerminal } from 'lucide-react';
import {
  CHAT_ZOOM_MAX,
  CHAT_ZOOM_MIN,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  UI_ZOOM_MAX,
  UI_ZOOM_MIN,
  type CloseBehavior,
  type ThemeMode,
} from '../../../shared/settings';
import type { CliCommandStatus } from '../../../shared/terminal';
import { cn } from '../../lib/cn';
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
import { SshHostKeysSettings } from './SshHostKeysSettings';
import { useDockOptions, useOnOffOptions } from './useLocalizedSettingsOptions';
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
        label={t('settings.appearance.chatZoom.label')}
        hint={t('settings.appearance.chatZoom.hint')}
      >
        <Stepper
          value={a.chatZoom}
          min={CHAT_ZOOM_MIN}
          max={CHAT_ZOOM_MAX}
          step={10}
          suffix="%"
          name={t('settings.appearance.chatZoom.label')}
          onChange={(chatZoom) => void update({ appearance: { chatZoom } })}
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
  const editor = useSettingsStore((s) => s.settings.editor);
  const update = useSettingsStore((s) => s.update);
  const onOffOptions = useOnOffOptions();
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
      <Field
        label={t('settings.editor.formatOnSave.label')}
        hint={t('settings.editor.formatOnSave.hint')}
      >
        <Segmented
          value={editor.formatOnSave ? 'on' : 'off'}
          options={onOffOptions}
          onChange={(v) => void update({ editor: { formatOnSave: v === 'on' } })}
        />
      </Field>
      <Field
        label={t('settings.editor.inlineBlame.label')}
        hint={t('settings.editor.inlineBlame.hint')}
      >
        <Segmented
          value={editor.inlineBlame ? 'on' : 'off'}
          options={onOffOptions}
          onChange={(v) => void update({ editor: { inlineBlame: v === 'on' } })}
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
      <CliCommandField />
    </Section>
  );
}

/**
 * Settings → Terminal: install/repair the `marudesk` shim on PATH so any
 * terminal can open the chat CLI against the running app. Main also installs
 * it at boot (electron/cli-command.ts); this is the visible status + retry.
 */
function CliCommandField() {
  const { t } = useI18n();
  const [status, setStatus] = useState<CliCommandStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.marudesk
      .invoke('cli:command-status')
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const install = async () => {
    setBusy(true);
    try {
      setStatus(await window.marudesk.invoke('cli:command-install'));
    } catch {
      // Keep the last known status; the button stays available.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Field
      label={t('settings.terminal.cliCommand.label')}
      hint={t('settings.terminal.cliCommand.hint')}
    >
      <div className="flex flex-col items-end gap-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => void install()}
          className={cn(
            'inline-flex items-center gap-1.5 h-8 px-3 rounded-md',
            'text-body-sm text-fg-secondary bg-surface-2',
            'hover:text-fg-primary hover:bg-surface-3 transition-colors duration-fast',
            busy && 'opacity-50 pointer-events-none',
          )}
        >
          <SquareTerminal size={14} />
          {status?.installed
            ? t('settings.terminal.cliCommand.reinstall')
            : t('settings.terminal.cliCommand.install')}
        </button>
        {status?.installed && status.path ? (
          <span className="max-w-72 truncate font-mono text-caption text-fg-tertiary" title={status.path}>
            {status.path}
          </span>
        ) : null}
        {status?.installed && !status.onPath ? (
          <span className="max-w-72 text-right text-caption text-fg-tertiary">
            {t('settings.terminal.cliCommand.notOnPath')}
          </span>
        ) : null}
        {status?.error ? (
          <span className="max-w-72 text-right text-caption text-error">{status.error}</span>
        ) : null}
      </div>
    </Field>
  );
}

/**
 * App-level behavior in one place — close-button behavior, the address-bar
 * search engine, and the DevTools dock were each a one-field category before;
 * merged so the left nav stays scannable.
 */
export function ApplicationCategory() {
  const { t } = useI18n();
  const dockOptions = useDockOptions();
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const closeOptions = [
    { value: 'tray', label: t('settings.window.closeBehavior.tray') },
    { value: 'quit', label: t('settings.window.closeBehavior.quit') },
  ] as const satisfies readonly {
    readonly value: CloseBehavior;
    readonly label: string;
  }[];
  return (
    <>
      <Section>
        <Field
          label={t('settings.window.closeBehavior.label')}
          hint={t('settings.window.closeBehavior.hint')}
        >
          <Segmented
            value={settings.window.closeBehavior}
            options={closeOptions}
            onChange={(closeBehavior) => void update({ window: { closeBehavior } })}
          />
        </Field>
        <Field
          label={t('settings.browser.searchEngine.label')}
          hint={t('settings.browser.searchEngine.hint')}
        >
          <Segmented
            value={settings.browser.searchEngine}
            options={SEARCH_ENGINE_OPTIONS}
            onChange={(searchEngine) => void update({ browser: { searchEngine } })}
          />
        </Field>
        <Field
          label={t('settings.devtools.dock.label')}
          hint={t('settings.devtools.dock.hint')}
        >
          <Segmented
            value={settings.devtools.defaultDock}
            options={dockOptions}
            onChange={(defaultDock) => void update({ devtools: { defaultDock } })}
          />
        </Field>
      </Section>
      <SshHostKeysSettings />
    </>
  );
}
