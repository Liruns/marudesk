import { useState } from 'react';
import { isGenericFamily, type FontOption } from '../../../shared/fonts';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { TextField } from './SettingsInputs';

const CUSTOM_FONT = '__custom__';

function isFontAvailable(family: string): boolean {
  const f = family.trim();
  if (!f || isGenericFamily(f)) return true;
  try {
    if (!document.fonts?.check) return true;
    return document.fonts.check(`12px '${f.replace(/'/g, '')}'`);
  } catch {
    return true;
  }
}

export function FontField({
  value,
  presets,
  onCommit,
}: {
  value: string;
  presets: readonly FontOption[];
  onCommit: (value: string) => void;
}) {
  const { t } = useI18n();
  const known = presets.some((p) => p.value === value);
  const [customMode, setCustomMode] = useState(!known && value !== '');
  const showCustom = customMode || (!known && value !== '');
  const available = isFontAvailable(value);
  return (
    <div className="flex flex-col items-stretch gap-1.5 w-[240px] max-w-[40vw]">
      <select
        value={showCustom ? CUSTOM_FONT : value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === CUSTOM_FONT) {
            setCustomMode(true);
          } else {
            setCustomMode(false);
            if (v !== value) onCommit(v);
          }
        }}
        className={cn(
          'h-8 w-full rounded-md bg-surface-page border border-default px-2.5',
          'text-body-sm text-fg-primary',
          'focus:outline-none focus:border-accent transition-colors duration-fast',
        )}
      >
        {presets.map((p) => (
          <option key={p.value || 'default'} value={p.value}>
            {p.label}
          </option>
        ))}
        <option value={CUSTOM_FONT}>{t('settings.font.custom')}</option>
      </select>
      {showCustom ? (
        <TextField
          value={value}
          placeholder={t('settings.font.placeholder')}
          onCommit={onCommit}
        />
      ) : null}
      {showCustom && value.trim() && !available ? (
        <span className="text-caption text-warning">
          {t('settings.font.notDetectedBefore')}
          {value}
          {t('settings.font.notDetectedAfter')}
        </span>
      ) : null}
    </div>
  );
}
