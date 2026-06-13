import { useState, type ReactNode } from 'react';
import {
  ChevronRight,
  Lock,
  ScanLine,
  ShieldCheck,
  Smartphone,
  Wifi,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { useI18n } from '../../i18n/useI18n';

type Step = { title: string; body: ReactNode };

/**
 * Friendly onboarding for the desktop/LAN remote bridge, shown in Settings →
 * Remote regardless of whether the server is on (so people can read the flow
 * before flipping the toggle). Another Maru desktop on the same account/network
 * connects to this host; the QR shown elsewhere while pairing is active carries
 * a pairing token, not a web link a normal camera can open.
 */
export function RemoteGuide() {
  const { t } = useI18n();
  const steps: Step[] = [
    {
      title: t('settings.remoteGuide.step1.title'),
      body: (
        <>
          {t('settings.remoteGuide.step1.before')}
          <span className="text-fg-primary">
            {t('settings.remoteGuide.step1.link')}
          </span>
          {t('settings.remoteGuide.step1.after')}
          <span className="text-fg-tertiary">
            {t('settings.remoteGuide.step1.devBuild')}
          </span>
        </>
      ),
    },
    {
      title: t('settings.remoteGuide.step2.title'),
      body: t('settings.remoteGuide.step2.body'),
    },
    {
      title: t('settings.remoteGuide.step3.title'),
      body: t('settings.remoteGuide.step3.body'),
    },
    {
      title: t('settings.remoteGuide.step4.title'),
      body: t('settings.remoteGuide.step4.body'),
    },
    {
      title: t('settings.remoteGuide.step5.title'),
      body: t('settings.remoteGuide.step5.body'),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-col gap-0.5">
        <h3 className="text-body font-medium text-fg-primary">
          {t('settings.remoteGuide.title')}
        </h3>
        <p className="text-caption text-fg-tertiary">
          {t('settings.remoteGuide.subtitle')}
        </p>
      </header>

      {/* The whole point of this task: a generic camera scan of the QR just
          shows base64 text, which confuses people. Make that explicit and loud. */}
      <div className="flex gap-2.5 rounded-lg bg-accent-subtle px-4 py-3">
        <ScanLine size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden />
        <p className="text-caption text-fg-secondary leading-relaxed">
          {t('settings.remoteGuide.qr.before')}
          <span className="text-fg-primary">
            {t('settings.remoteGuide.qr.scanner')}
          </span>
          {t('settings.remoteGuide.qr.after')}
        </p>
      </div>

      <ol className="flex flex-col gap-3 rounded-lg border border-subtle bg-surface-1 px-4 py-4">
        {steps.map((step, i) => (
          <li key={step.title} className="flex gap-3">
            <span
              className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-caption font-medium text-accent"
              aria-hidden
            >
              {i + 1}
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-body-sm text-fg-primary">{step.title}</span>
              <span className="text-caption text-fg-tertiary leading-relaxed">{step.body}</span>
            </div>
          </li>
        ))}
      </ol>

      <div className="flex items-center gap-2 px-1 text-caption text-fg-tertiary">
        <Wifi size={13} className="shrink-0" aria-hidden />
        <span>{t('settings.remoteGuide.requirements')}</span>
      </div>

      <SecurityDetails />
    </div>
  );
}

/** Optional, secondary "how the security works" disclosure — collapsed by default. */
function SecurityDetails() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 self-start text-caption uppercase tracking-wider text-fg-tertiary hover:text-fg-secondary transition-colors duration-fast"
      >
        <ChevronRight size={13} className={cn('transition-transform', open && 'rotate-90')} />
        {t('settings.remoteGuide.security.title')}
      </button>
      {open ? (
        <div className="flex flex-col gap-2.5 rounded-lg border border-subtle bg-surface-1 px-4 py-3">
          <div className="flex gap-2.5">
            <Lock size={15} className="mt-0.5 shrink-0 text-fg-tertiary" aria-hidden />
            <p className="text-caption text-fg-secondary leading-relaxed">
              {t('settings.remoteGuide.security.transport')}
            </p>
          </div>
          <div className="flex gap-2.5">
            <ShieldCheck size={15} className="mt-0.5 shrink-0 text-fg-tertiary" aria-hidden />
            <p className="text-caption text-fg-secondary leading-relaxed">
              {t('settings.remoteGuide.security.identity')}
            </p>
          </div>
          <div className="flex gap-2.5">
            <Smartphone size={15} className="mt-0.5 shrink-0 text-fg-tertiary" aria-hidden />
            <p className="text-caption text-fg-secondary leading-relaxed">
              {t('settings.remoteGuide.security.revoke')}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
