import { useState } from 'react';
import { ArrowDown, ArrowUp, Plus as PlusIcon, X } from 'lucide-react';
import {
  isProviderId,
  type ModelEntry,
  type ProviderId,
} from '../../../shared/providers';
import type { ModelRef } from '../../../shared/settings';
import { useI18n } from '../../i18n/useI18n';
import { ProviderGlyph } from '../providers/ProviderGlyph';
import { useConnectedToolModels } from './useConnectedModels';
import { STEP_BTN } from './settingsControlStyles';

type FallbackChainProps = {
  readonly order: readonly ModelRef[];
  readonly onChange: (order: ModelRef[]) => void;
};

export function FallbackChain({ order, onChange }: FallbackChainProps) {
  const { t } = useI18n();
  const { models, toolModels, isConnected } = useConnectedToolModels();
  const [adding, setAdding] = useState(false);

  const labelFor = (ref: ModelRef) =>
    models.find((model) => model.provider === ref.provider && model.id === ref.model)
      ?.label ?? ref.model;

  const inChain = new Set(order.map((ref) => `${ref.provider}:${ref.model}`));
  const candidates = toolModels.filter(
    (model) => !inChain.has(`${model.provider}:${model.id}`),
  );

  const move = (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= order.length) return;
    const next = order.slice();
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    onChange(next);
  };
  const removeAt = (index: number) =>
    onChange(order.filter((_, candidateIndex) => candidateIndex !== index));
  const addModel = (model: ModelEntry) => {
    onChange([...order, { provider: model.provider, model: model.id }]);
    setAdding(false);
  };

  return (
    <div className="flex flex-col gap-2">
      {order.length === 0 ? (
        <p className="text-caption text-fg-tertiary">
          {t('settings.agent.fallback.empty')}
        </p>
      ) : (
        <ol className="flex flex-col gap-1">
          {order.map((ref, index) => {
            const connected = isConnected(ref.provider);
            const label = labelFor(ref);
            return (
              <li
                key={`${ref.provider}:${ref.model}`}
                className="flex items-center gap-2 rounded-md bg-surface-2 px-2 py-1.5"
              >
                <span className="w-4 shrink-0 text-center text-caption tabular-nums text-fg-tertiary">
                  {index + 1}
                </span>
                <FallbackProviderGlyph provider={ref.provider} label={label} />
                <span className="flex-1 truncate text-body-sm text-fg-secondary">
                  {label}
                </span>
                {!connected ? (
                  <span
                    title={t('settings.agent.fallback.notConnectedTitle')}
                    className="shrink-0 rounded-pill bg-warning-subtle px-1.5 py-px text-[10px] font-medium text-warning"
                  >
                    {t('settings.agent.fallback.notConnected')}
                  </span>
                ) : null}
                <button
                  type="button"
                  aria-label={t('settings.agent.fallback.moveUp')}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  className={STEP_BTN}
                >
                  <ArrowUp size={13} />
                </button>
                <button
                  type="button"
                  aria-label={t('settings.agent.fallback.moveDown')}
                  disabled={index === order.length - 1}
                  onClick={() => move(index, 1)}
                  className={STEP_BTN}
                >
                  <ArrowDown size={13} />
                </button>
                <button
                  type="button"
                  aria-label={t('settings.agent.fallback.remove')}
                  onClick={() => removeAt(index)}
                  className={STEP_BTN}
                >
                  <X size={13} />
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {adding ? (
        <div className="flex max-h-52 flex-col overflow-y-auto rounded-md border border-subtle bg-surface-1">
          {candidates.length === 0 ? (
            <p className="px-3 py-2 text-caption text-fg-tertiary">
              {t('settings.agent.fallback.noMoreModels')}
            </p>
          ) : (
            candidates.map((model) => (
              <button
                key={model.key}
                type="button"
                onClick={() => addModel(model)}
                className="flex items-center gap-2 px-3 py-1.5 text-left text-body-sm text-fg-secondary hover:bg-surface-2 transition-colors duration-fast"
              >
                <ProviderGlyph provider={model.provider} label={model.label} size={16} />
                <span className="flex-1 truncate">{model.label}</span>
              </button>
            ))
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex items-center gap-1.5 self-start rounded-md px-2 py-1 text-caption text-accent hover:bg-accent-subtle/40 transition-colors duration-fast"
        >
          <PlusIcon size={13} />
          {t('settings.agent.fallback.addModel')}
        </button>
      )}
    </div>
  );
}

function FallbackProviderGlyph({
  provider,
  label,
}: {
  readonly provider: string;
  readonly label: string;
}) {
  const glyphProvider: ProviderId = isProviderId(provider)
    ? provider
    : 'custom:unknown';
  return <ProviderGlyph provider={glyphProvider} label={label} size={16} />;
}
