import { Brain, Check, Eye, FlaskConical, Star } from 'lucide-react';
import type { Ref } from 'react';
import type { ModelEntry } from '../../../shared/providers';
import { cn } from '../../lib/cn';
import { ProviderGlyph } from '../providers/ProviderGlyph';
import { formatContext } from './ModelPaletteFormat';

export function SectionHeader({
  label,
  experimental,
  hasKey,
  showStatus,
  experimentalLabel,
  connectedTitle,
  notConnectedTitle,
}: {
  label: string;
  experimental: boolean;
  hasKey: boolean;
  showStatus: boolean;
  experimentalLabel: string;
  connectedTitle: string;
  notConnectedTitle: string;
}) {
  return (
    <div className="flex items-center gap-1.5 px-3 pb-1 pt-2.5 text-caption uppercase tracking-wider text-fg-tertiary">
      <span>{label}</span>
      {experimental ? (
        <span className="inline-flex items-center gap-0.5 rounded-pill bg-warning-subtle px-1.5 py-px text-kbd font-medium normal-case tracking-normal text-warning">
          <FlaskConical size={9} /> {experimentalLabel}
        </span>
      ) : null}
      {showStatus ? (
        <span
          aria-hidden
          title={hasKey ? connectedTitle : notConnectedTitle}
          className={cn('size-1.5 rounded-pill', hasKey ? 'bg-success' : 'bg-fg-tertiary/40')}
        />
      ) : null}
    </div>
  );
}

export function ModelRow({
  model,
  index,
  rowRef,
  active,
  selected,
  favorite,
  showQuickKey,
  visionLabel,
  reasoningLabel,
  favoriteLabel,
  unfavoriteLabel,
  optionProps,
  onChoose,
  onHover,
  onToggleFavorite,
}: {
  model: ModelEntry;
  index: number;
  rowRef?: Ref<HTMLButtonElement>;
  active: boolean;
  selected: boolean;
  favorite: boolean;
  showQuickKey: boolean;
  visionLabel: string;
  reasoningLabel: string;
  favoriteLabel: string;
  unfavoriteLabel: string;
  /** ARIA option semantics (stable id + aria-selected) from the shared palette listbox. */
  optionProps: { id: string; 'aria-selected': boolean };
  onChoose: () => void;
  onHover: () => void;
  onToggleFavorite: () => void;
}) {
  return (
    <button
      ref={rowRef}
      type="button"
      onClick={onChoose}
      onMouseEnter={onHover}
      {...optionProps}
      className={cn(
        'group flex w-full items-center gap-2 px-3 py-1.5 text-left text-body-sm transition-colors',
        active ? 'bg-surface-2 text-fg-primary' : 'text-fg-secondary',
      )}
    >
      <ProviderGlyph provider={model.provider} label={model.label} size={18} />
      {showQuickKey ? (
        <kbd className="shrink-0 rounded bg-surface-3 px-1 text-kbd font-medium tabular-nums text-fg-tertiary">
          {index + 1}
        </kbd>
      ) : null}
      <span className="flex-1 truncate">{model.label}</span>
      {model.vision ? <Eye size={12} className="shrink-0 text-ai-read" aria-label={visionLabel} /> : null}
      {model.reasoning ? (
        <Brain size={12} className="shrink-0 text-ai-thinking" aria-label={reasoningLabel} />
      ) : null}
      {model.contextWindow ? (
        <span className="shrink-0 rounded bg-surface-3/70 px-1 text-kbd tabular-nums text-fg-tertiary">
          {formatContext(model.contextWindow)}
        </span>
      ) : null}
      <span
        role="button"
        tabIndex={-1}
        aria-label={favorite ? unfavoriteLabel : favoriteLabel}
        onClick={(event) => {
          event.stopPropagation();
          onToggleFavorite();
        }}
        className={cn(
          'shrink-0 transition-opacity',
          favorite ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
      >
        <Star
          size={13}
          className={cn('transition-colors duration-fast', favorite ? 'text-warning' : 'text-fg-tertiary/60 hover:text-fg-tertiary')}
          fill={favorite ? 'currentColor' : 'none'}
        />
      </span>
      {selected ? (
        <Check size={13} className="shrink-0 text-accent" />
      ) : (
        <span aria-hidden className="w-[13px] shrink-0" />
      )}
    </button>
  );
}
