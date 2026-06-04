import { Save, X } from 'lucide-react';
import { useI18n } from '../../../i18n/useI18n';
import { useDevtoolsStore } from '../store';

export function SourcePatchBanner() {
  const { t } = useI18n();
  const pending = useDevtoolsStore((s) => s.pendingPatch);
  const apply = useDevtoolsStore((s) => s.applySourcePatch);
  const dismiss = useDevtoolsStore((s) => s.dismissSourcePatch);
  if (!pending) return null;
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-accent-subtle/60 border-b border-accent/40 backdrop-blur-sm">
      <span className="text-caption text-fg-secondary min-w-0 truncate">
        {t('devtools.styles.mapsTo')}{' '}
        <span className="font-mono text-fg-primary" title={pending.path}>
          {pending.path}:{pending.startLine}
        </span>
      </span>
      <button
        type="button"
        onClick={() => void apply()}
        className="ml-auto shrink-0 flex items-center gap-1 h-6 px-2 rounded bg-accent text-white text-caption hover:bg-accent-hover"
      >
        <Save size={12} />
        {t('devtools.styles.saveToSource')}
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('agent.chat.dismiss')}
        className="shrink-0 text-fg-tertiary hover:text-fg-primary"
      >
        <X size={14} />
      </button>
    </div>
  );
}
