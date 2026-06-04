import { ChevronRight } from 'lucide-react';
import { getProvider, type BuiltinProviderId } from '../../../shared/providers';
import { Badge } from '../../components/ui';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { ProviderGlyph } from '../providers/ProviderGlyph';
import { ProviderKeyEditor } from './ProviderKeyEditor';
import { ProviderOAuthConnect } from './ProviderOAuthConnect';

type ProviderCardProps = {
  readonly providerId: BuiltinProviderId;
  readonly hasKey: boolean;
  readonly oauthConnected: boolean;
  readonly expanded: boolean;
  readonly onSelect: () => void;
};

export function ProviderCard({
  providerId,
  hasKey,
  oauthConnected,
  expanded,
  onSelect,
}: ProviderCardProps) {
  const { t } = useI18n();
  const provider = getProvider(providerId);

  return (
    <div className="rounded-lg border border-subtle bg-surface-1 overflow-hidden">
      <button
        type="button"
        onClick={onSelect}
        aria-expanded={expanded}
        className="w-full flex items-center gap-2 px-3 h-11 text-left"
      >
        <ChevronRight
          size={14}
          className={cn(
            'text-fg-tertiary shrink-0 transition-transform',
            expanded && 'rotate-90',
          )}
        />
        <ProviderGlyph provider={provider.id} label={provider.label} size={20} />
        <span className="text-body-sm text-fg-primary">{provider.label}</span>
        {provider.experimental ? (
          <Badge variant="warning">
            {t('settings.providers.badge.experimental')}
          </Badge>
        ) : null}
        <span className="flex-1" />
        {oauthConnected ? (
          <Badge variant="accent">
            {provider.oauthOnly
              ? t('settings.providers.badge.connected')
              : t('settings.providers.badge.subscription')}
          </Badge>
        ) : null}
        {provider.keyless ? (
          <Badge variant="neutral">{t('settings.providers.badge.local')}</Badge>
        ) : provider.oauthOnly ? (
          oauthConnected ? null : (
            <Badge variant="neutral">
              {t('settings.providers.badge.signIn')}
            </Badge>
          )
        ) : (
          <Badge variant={hasKey ? 'accent' : 'neutral'}>
            {hasKey
              ? t('settings.providers.badge.keySet')
              : t('settings.providers.badge.noKey')}
          </Badge>
        )}
      </button>

      {expanded ? (
        <div className="border-t border-subtle px-3 py-3 flex flex-col gap-3">
          {provider.keyless ? (
            <p className="text-caption text-fg-tertiary">
              {provider.apiKeyHint}
            </p>
          ) : (
            <>
              {provider.oauth ? (
                <ProviderOAuthConnect
                  providerId={providerId}
                  connected={oauthConnected}
                />
              ) : null}
              {provider.oauthOnly ? null : (
                <ProviderKeyEditor providerId={providerId} hasKey={hasKey} />
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
