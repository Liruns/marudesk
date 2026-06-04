import { useState } from 'react';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { useProvidersStore } from '../providers/store';

export function AddCustomEndpointForm({
  onDone,
}: {
  readonly onDone: () => void;
}) {
  const { t } = useI18n();
  const add = useProvidersStore((s) => s.addCustomProvider);
  const busy = useProvidersStore((s) => s.customBusy);
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [modelsText, setModelsText] = useState('');
  const [apiKey, setApiKey] = useState('');

  const modelIds = modelsText
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const valid =
    label.trim().length > 0 && baseUrl.trim().length > 0 && modelIds.length > 0;

  const submit = async () => {
    if (!valid || busy) return;
    const ok = await add({
      label: label.trim(),
      baseUrl: baseUrl.trim(),
      modelIds,
      apiKey: apiKey.trim() || undefined,
    });
    if (ok) {
      setLabel('');
      setBaseUrl('');
      setModelsText('');
      setApiKey('');
      onDone();
    }
  };

  const field =
    'w-full rounded-md bg-surface-page border border-default px-3 text-body-sm text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:border-accent transition-colors duration-fast';

  return (
    <div className="rounded-lg border border-subtle bg-surface-1 px-3 py-3 flex flex-col gap-2.5">
      <label className="flex flex-col gap-1">
        <span className="text-caption text-fg-tertiary">
          {t('settings.providers.custom.name')}
        </span>
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="OpenRouter"
          spellCheck={false}
          className={cn(field, 'h-9')}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-caption text-fg-tertiary">
          {t('settings.providers.custom.baseUrl')}
        </span>
        <input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://openrouter.ai/api/v1"
          spellCheck={false}
          autoComplete="off"
          className={cn(field, 'h-9 font-mono')}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-caption text-fg-tertiary">
          {t('settings.providers.custom.modelIds')}
        </span>
        <textarea
          value={modelsText}
          onChange={(event) => setModelsText(event.target.value)}
          rows={2}
          placeholder="anthropic/claude-sonnet-4.6, openai/gpt-5"
          spellCheck={false}
          className={cn(field, 'py-2 font-mono resize-none')}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-caption text-fg-tertiary">
          {t('settings.providers.custom.apiKeyOptional')}
        </span>
        <input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={t('settings.providers.custom.addKeyPlaceholder')}
          spellCheck={false}
          autoComplete="off"
          className={cn(field, 'h-9 font-mono')}
        />
      </label>
      <div className="flex items-center gap-2 pt-0.5">
        <Button
          variant="primary"
          size="sm"
          onClick={() => void submit()}
          disabled={!valid || busy}
        >
          {busy
            ? t('settings.providers.custom.adding')
            : t('settings.providers.custom.addEndpoint')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone} disabled={busy}>
          {t('settings.providers.cancel')}
        </Button>
      </div>
    </div>
  );
}
