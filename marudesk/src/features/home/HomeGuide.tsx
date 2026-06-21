import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { useI18n } from '../../i18n/useI18n';
import type { TranslationKey } from '../../i18n/messages';
import { useTourStore } from '../tour/tourStore';

export type HomeScenario = {
  readonly key: string;
  readonly icon: ReactNode;
  readonly label: TranslationKey;
  readonly desc: TranslationKey;
  readonly onOpen: () => void;
};

/**
 * The first-run "What can you do?" guide: a dismissible panel of representative
 * scenario cards. Each card runs the real action, so the guide doubles as a
 * launcher. Shown automatically until dismissed (see onboarding.ts).
 */
export function HomeGuide({
  scenarios,
  onDismiss,
}: {
  readonly scenarios: readonly HomeScenario[];
  readonly onDismiss: () => void;
}) {
  const { t } = useI18n();
  const startTour = useTourStore((s) => s.start);
  return (
    <section
      aria-label={t('home.guide.title')}
      className="@container w-full max-w-2xl rounded-lg border border-subtle bg-surface-2 p-4 animate-fade-rise"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-body-sm font-medium text-fg-primary">{t('home.guide.title')}</h2>
          <p className="text-caption text-fg-tertiary">{t('home.guide.subtitle')}</p>
        </div>
        <button
          type="button"
          aria-label={t('home.guide.dismiss')}
          title={t('home.guide.dismiss')}
          onClick={onDismiss}
          className="chrome-icon-button size-7 shrink-0"
        >
          <X size={15} />
        </button>
      </div>

      <div className="mt-4 grid grid-cols-1 @md:grid-cols-2 gap-2.5">
        {scenarios.map((s, i) => (
          <button
            key={s.key}
            type="button"
            onClick={s.onOpen}
            className={cn(
              'group flex items-start gap-3 rounded-lg border border-subtle bg-surface-page p-3 text-left transition-colors duration-fast hover:border-default hover:bg-surface-3',
              // Odd card out spans the full row at the 2-column breakpoint, so the
              // last scenario never sits beside an empty half-cell.
              i === scenarios.length - 1 && scenarios.length % 2 === 1 && '@md:col-span-2',
            )}
          >
            <span className="mt-0.5 shrink-0 text-accent">{s.icon}</span>
            <span className="min-w-0 flex flex-col gap-0.5">
              <span className="text-body-sm font-medium text-fg-primary">{t(s.label)}</span>
              <span className="text-caption text-fg-tertiary">{t(s.desc)}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={startTour}
          className="rounded-md px-3 py-1.5 text-caption text-fg-secondary transition-colors duration-fast hover:text-fg-primary hover:bg-surface-3"
        >
          {t('tour.start')}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-md border border-subtle bg-surface-page px-3 py-1.5 text-caption text-fg-secondary transition-colors duration-fast hover:text-fg-primary hover:bg-surface-3"
        >
          {t('home.guide.dismiss')}
        </button>
      </div>
    </section>
  );
}
