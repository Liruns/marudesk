import { useEffect, useState } from 'react';
import { Clock, Loader2, Play, Plus, Trash2 } from 'lucide-react';
import { Button, Switch } from '../../components/ui';
import { useI18n } from '../../i18n/useI18n';
import { describeSchedule, type Automation } from '../../../shared/automations';

/**
 * Settings → Automations (Stage 12-C). Lists saved scheduled prompts with an
 * enable toggle, last-run status, Run-now + delete, and a compact create form.
 * An automation runs detached as a read-only agent on its interval (the host
 * owns scheduling + execution; this is a thin control surface).
 */
const DEFAULT_PROVIDER = 'anthropic';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

export function AutomationsSettings() {
  const { t } = useI18n();
  const [items, setItems] = useState<Automation[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  // create form
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [everyMinutes, setEveryMinutes] = useState(60);
  const [provider, setProvider] = useState(DEFAULT_PROVIDER);
  const [model, setModel] = useState(DEFAULT_MODEL);

  const load = (): void => {
    void window.marudesk
      .invoke('automations:list')
      .then(setItems)
      .catch(() => setItems([]));
  };
  useEffect(load, []);

  const create = async (): Promise<void> => {
    if (!name.trim() || !prompt.trim()) return;
    setBusy(true);
    try {
      await window.marudesk.invoke('automations:create', {
        name: name.trim(),
        prompt: prompt.trim(),
        provider: provider.trim() || DEFAULT_PROVIDER,
        model: model.trim() || DEFAULT_MODEL,
        schedule: { kind: 'interval', everyMinutes },
        allowTools: [],
        enabled: true,
      });
      setName('');
      setPrompt('');
      load();
    } catch {
      // leave the form as-is; a transient failure shouldn't drop the draft
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (id: string, enabled: boolean): Promise<void> => {
    await window.marudesk.invoke('automations:set-enabled', { id, enabled }).catch(() => {});
    load();
  };

  const remove = async (id: string): Promise<void> => {
    await window.marudesk.invoke('automations:delete', { id }).catch(() => {});
    load();
  };

  const runNow = async (id: string): Promise<void> => {
    setRunning(id);
    try {
      await window.marudesk.invoke('automations:run-now', { id });
      load();
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-caption text-fg-tertiary">{t('settings.automations.hint')}</p>

      <div className="flex flex-col gap-2">
        {items === null ? (
          <Row text={t('settings.automations.loading')} />
        ) : items.length === 0 ? (
          <Row text={t('settings.automations.empty')} />
        ) : (
          items.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-2 rounded-lg border border-subtle bg-surface-1 px-4 py-2"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-body-sm font-medium text-fg-primary truncate">{a.name}</span>
                <span className="flex items-center gap-1.5 text-caption text-fg-tertiary">
                  <Clock size={11} className="shrink-0" />
                  {describeSchedule(a.schedule)} · {a.provider}/{a.model}
                  {a.lastRun ? (
                    <span className={a.lastRun.status === 'error' ? 'text-error' : 'text-success'}>
                      · {a.lastRun.status === 'error' ? t('settings.automations.failed') : t('settings.automations.ok')}
                    </span>
                  ) : (
                    <span>· {t('settings.automations.never')}</span>
                  )}
                </span>
              </div>
              <div className="ml-auto flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => void runNow(a.id)}
                  disabled={running === a.id}
                  title={t('settings.automations.runNow')}
                  aria-label={t('settings.automations.runNow')}
                  className="text-fg-tertiary hover:text-accent disabled:opacity-50"
                >
                  {running === a.id ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                </button>
                <Switch
                  checked={a.enabled}
                  onChange={(next) => void toggle(a.id, next)}
                  label={`${a.enabled ? t('settings.option.off') : t('settings.option.on')} ${a.name}`}
                />
                <button
                  type="button"
                  onClick={() => void remove(a.id)}
                  title={t('settings.automations.delete')}
                  aria-label={t('settings.automations.delete')}
                  className="text-fg-tertiary hover:text-error"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* create form */}
      <div className="flex flex-col gap-2 rounded-lg border border-dashed border-subtle bg-surface-1 p-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('settings.automations.namePlaceholder')}
          className="rounded border border-subtle bg-surface-page px-2 py-1.5 text-body-sm text-fg-primary"
        />
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t('settings.automations.promptPlaceholder')}
          rows={2}
          className="resize-none rounded border border-subtle bg-surface-page px-2 py-1.5 text-body-sm text-fg-primary"
        />
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-caption text-fg-tertiary">
            {t('settings.automations.everyMinutes')}
            <input
              type="number"
              min={5}
              value={everyMinutes}
              onChange={(e) => setEveryMinutes(Math.max(5, Number(e.target.value) || 5))}
              className="w-16 rounded border border-subtle bg-surface-page px-2 py-1 text-body-sm text-fg-primary"
            />
          </label>
          <input
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            placeholder={DEFAULT_PROVIDER}
            className="w-28 rounded border border-subtle bg-surface-page px-2 py-1 text-body-sm text-fg-primary"
          />
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={DEFAULT_MODEL}
            className="flex-1 min-w-32 rounded border border-subtle bg-surface-page px-2 py-1 text-body-sm text-fg-primary"
          />
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<Plus size={14} />}
            onClick={() => void create()}
            disabled={busy || !name.trim() || !prompt.trim()}
          >
            {t('settings.automations.create')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Row({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-subtle bg-surface-1 px-4 py-2 text-body-sm text-fg-tertiary">
      <Clock size={15} className="shrink-0" />
      <span>{text}</span>
    </div>
  );
}
