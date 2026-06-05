import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { CustomProviderInfo } from '../../../shared/providers';
import { Badge, Button } from '../../components/ui';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { CustomEndpointKeyEditor } from './CustomEndpointKeyEditor';

export function CustomEndpointCard({
  provider,
  onRemove,
}: {
  readonly provider: CustomProviderInfo;
  readonly onRemove: () => void;
}) {
  const { formatProviderModelCount, t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="chrome-panel rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
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
        <span className="text-body-sm text-fg-primary shrink-0">
          {provider.label}
        </span>
        <span className="text-caption text-fg-tertiary truncate font-mono">
          {provider.baseUrl}
        </span>
        <span className="flex-1" />
        <Badge variant="neutral">
          {formatProviderModelCount(provider.models.length)}
        </Badge>
        <Badge variant={provider.hasKey ? 'accent' : 'neutral'}>
          {provider.hasKey
            ? t('settings.providers.badge.keySet')
            : t('settings.providers.badge.noKey')}
        </Badge>
      </button>
      {expanded ? (
        <div className="border-t border-subtle px-3 py-3 flex flex-col gap-3">
          <div className="text-caption text-fg-tertiary">
            {t('settings.providers.custom.models')}{' '}
            <span className="font-mono text-fg-secondary break-all">
              {provider.models.map((model) => model.id).join(', ')}
            </span>
          </div>
          <CustomEndpointKeyEditor provider={provider} />
          <div>
            <Button variant="ghost" size="sm" onClick={onRemove}>
              {t('settings.providers.custom.removeEndpoint')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
