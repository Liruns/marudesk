import { useEffect, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { ModelRef } from '../../../shared/settings';
import { useI18n } from '../../i18n/useI18n';
import { ProviderGlyph } from '../providers/ProviderGlyph';
import { useProvidersStore } from '../providers/store';

/**
 * Single optional model picker for the delegate (subagent) model (v6 §G5/U7).
 * `null` = inherit the parent model (default). Lists connected, tool-capable
 * models — the same source the fallback chain uses — plus an "Inherit" choice to
 * clear. Kept compact (a popover) since it's one value, not an ordered list.
 */
export function DelegateModelField({
  value,
  onChange,
}: {
  readonly value: ModelRef | null;
  readonly onChange: (value: ModelRef | null) => void;
}) {
  const { t } = useI18n();
  const models = useProvidersStore((s) => s.models);
  const providerStatus = useProvidersStore((s) => s.providerStatus);
  const statusChecked = useProvidersStore((s) => s.statusChecked);
  const refreshProviderStatus = useProvidersStore((s) => s.refreshProviderStatus);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!statusChecked) void refreshProviderStatus();
  }, [statusChecked, refreshProviderStatus]);

  const isConnected = (provider: string) => {
    if (provider.startsWith('custom:')) return true;
    const status = providerStatus.find((c) => c.id === provider);
    return !!status?.hasKey || !!status?.oauth;
  };
  const candidates = models.filter((m) => m.tools !== false && isConnected(m.provider));
  const current = value
    ? models.find((m) => m.provider === value.provider && m.id === value.model)
    : undefined;
  const currentLabel = value
    ? current?.label ?? value.model
    : t('settings.agent.delegateModel.inherit');

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md bg-surface-2 px-2 py-1.5 text-left text-body-sm text-fg-secondary hover:bg-surface-3 transition-colors duration-fast"
        aria-expanded={open}
      >
        {current ? <ProviderGlyph provider={current.provider} label={currentLabel} size={16} /> : null}
        <span className="flex-1 truncate">{currentLabel}</span>
        <ChevronDown size={14} className="shrink-0 text-fg-tertiary" />
      </button>
      {open ? (
        <div className="absolute z-10 mt-1 flex max-h-60 w-full flex-col overflow-y-auto rounded-md border border-subtle bg-surface-1 shadow-lifted">
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className="flex items-center gap-2 px-3 py-1.5 text-left text-body-sm text-fg-secondary hover:bg-surface-2 transition-colors duration-fast"
          >
            <span className="flex-1">{t('settings.agent.delegateModel.inherit')}</span>
            {value === null ? <Check size={14} className="text-accent" /> : null}
          </button>
          {candidates.map((m) => {
            const selected = value?.provider === m.provider && value?.model === m.id;
            return (
              <button
                key={m.key}
                type="button"
                onClick={() => {
                  onChange({ provider: m.provider, model: m.id });
                  setOpen(false);
                }}
                className="flex items-center gap-2 px-3 py-1.5 text-left text-body-sm text-fg-secondary hover:bg-surface-2 transition-colors duration-fast"
              >
                <ProviderGlyph provider={m.provider} label={m.label} size={16} />
                <span className="flex-1 truncate">{m.label}</span>
                {selected ? <Check size={14} className="text-accent" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
