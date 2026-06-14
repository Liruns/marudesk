import { useState } from 'react';
import { ChevronDown, ChevronRight, Terminal } from 'lucide-react';
import { getProvider, type BuiltinProviderId } from '../../../shared/providers';
import { Badge } from '../../components/ui';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { ProviderGlyph } from '../providers/ProviderGlyph';
import { ProviderKeyEditor } from './ProviderKeyEditor';
import { ProviderOAuthConnect } from './ProviderOAuthConnect';

const ADC_PROVIDERS = new Set<BuiltinProviderId>(['google-vertex', 'amazon-bedrock']);

const ADC_SETUP_STEPS: Record<string, ReadonlyArray<{ instruction: string; code?: string }>> = {
  'google-vertex': [
    { instruction: 'Install the gcloud CLI', code: undefined },
    { instruction: 'Authenticate with Application Default Credentials', code: 'gcloud auth application-default login' },
    { instruction: 'Set your project', code: 'export GOOGLE_CLOUD_PROJECT=your-project-id' },
  ],
  'amazon-bedrock': [
    { instruction: 'Configure AWS credentials', code: 'aws configure' },
    {
      instruction: 'Or set environment variables',
      code: 'export AWS_ACCESS_KEY_ID=...\nexport AWS_SECRET_ACCESS_KEY=...',
    },
    { instruction: 'Set your region', code: 'export AWS_REGION=us-east-1' },
  ],
};

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
  const { t, formatProviderModelCount } = useI18n();
  const provider = getProvider(providerId);
  const isAdcProvider = ADC_PROVIDERS.has(providerId);
  const [guideOpen, setGuideOpen] = useState(false);

  return (
    <div className="chrome-panel rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={onSelect}
        aria-expanded={expanded}
        className="chrome-list-row w-full gap-2 px-3 h-11 text-left rounded-none"
      >
        <ChevronRight
          size={14}
          className={cn(
            'text-fg-tertiary shrink-0 transition-transform',
            expanded && 'rotate-90',
          )}
        />
        <ProviderGlyph provider={provider.id} label={provider.label} size={20} />
        <span className="min-w-0 flex-1 truncate text-body-sm text-fg-primary">{provider.label}</span>
        {provider.experimental ? (
          <Badge variant="warning">
            {t('settings.providers.badge.experimental')}
          </Badge>
        ) : null}
        {provider.models.length > 0 ? (
          // Decorative — kept out of the button's accessible name (which status
          // selectors key on, e.g. "Anthropic · no key").
          <span aria-hidden className="shrink-0 tabular-nums text-caption text-fg-tertiary">
            {formatProviderModelCount(provider.models.length)}
          </span>
        ) : null}
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
          {isAdcProvider ? (
            <div className="bg-surface-page/60 border border-subtle rounded-md">
              <button
                type="button"
                onClick={() => setGuideOpen((prev) => !prev)}
                className="flex items-center gap-2 w-full px-3 py-2 text-left"
              >
                <Terminal size={13} className="text-fg-tertiary shrink-0" />
                <span className="text-caption text-fg-tertiary">
                  {guideOpen
                    ? t('settings.providers.setupGuide.collapse')
                    : t('settings.providers.setupGuide.expand')}
                </span>
                <span className="flex-1" />
                <ChevronDown
                  size={13}
                  className={cn(
                    'text-fg-tertiary transition-transform',
                    guideOpen && 'rotate-180',
                  )}
                />
              </button>
              {guideOpen ? (
                <div className="px-3 pb-3 flex flex-col gap-2">
                  {ADC_SETUP_STEPS[providerId]?.map((step, i) => (
                    <div key={i} className="flex flex-col gap-1">
                      <p className="text-caption text-fg-tertiary">
                        {t('settings.providers.setupGuide.step')} {i + 1}: {step.instruction}
                      </p>
                      {step.code ? (
                        <pre className="text-caption font-mono bg-surface-raised border border-default rounded px-2 py-1 overflow-x-auto whitespace-pre-wrap">
                          {step.code}
                        </pre>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
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
