import { useI18n } from '../../i18n/useI18n';
import { useDevtoolsStore } from './store';

export function DevtoolsGate({ kind }: { kind: 'detached' | 'attaching' }) {
  const { t } = useI18n();
  const reason = useDevtoolsStore((s) => s.detachReason);
  if (kind === 'attaching') {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-body-sm text-fg-tertiary">
        {t('devtools.connecting')}
      </div>
    );
  }
  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-body-sm text-fg-secondary">{t('devtools.disconnected')}</p>
      {reason ? (
        <p className="text-caption text-fg-tertiary max-w-xs break-words">{reason}</p>
      ) : null}
      <button
        type="button"
        onClick={() => useDevtoolsStore.getState().reconnect()}
        className="h-7 px-3 rounded-md bg-accent-subtle/50 text-accent text-body-sm hover:bg-accent-subtle/70 transition-colors duration-fast"
      >
        {t('devtools.reconnect')}
      </button>
    </div>
  );
}
