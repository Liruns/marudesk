import { useEffect, useState } from 'react';
import { ChevronRight, TriangleAlert } from 'lucide-react';
import type { ServerStatus } from '../../../shared/remote';
import { SERVER_PORT_MAX, SERVER_PORT_MIN } from '../../../shared/settings';
import { CopyButton } from '../../components/ui';
import { useIpcListener } from '../../hooks';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { Field, Section, Segmented, Stepper } from './SettingsControls';
import { useSettingsStore } from './store';
import { useOnOffOptions } from './useLocalizedSettingsOptions';

export function AdvancedRemote() {
  const { t } = useI18n();
  const server = useSettingsStore((s) => s.settings.server);
  const update = useSettingsStore((s) => s.update);
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex items-center gap-1.5 self-start text-caption uppercase tracking-wider text-fg-tertiary hover:text-fg-secondary transition-colors duration-fast"
      >
        <ChevronRight
          size={13}
          className={cn('transition-transform', open && 'rotate-90')}
        />
        {t('settings.remote.advanced.toggle')}
      </button>
      {open ? (
        <div className="flex flex-col gap-4">
          <Section>
            <Field
              label={t('settings.remote.advanced.port.label')}
              hint={t('settings.remote.advanced.port.hint')}
            >
              <Stepper
                value={server.port}
                min={SERVER_PORT_MIN}
                max={SERVER_PORT_MAX}
                step={1}
                name={t('settings.remote.advanced.port.name')}
                onChange={(port) => void update({ server: { port } })}
              />
            </Field>
          </Section>
          <LocalServerReach />
          <UnattendedToggle />
        </div>
      ) : null}
    </div>
  );
}

function UnattendedToggle() {
  const { t } = useI18n();
  const onOffOptions = useOnOffOptions();
  const skip = useSettingsStore((s) => s.settings.server.skipApprovals);
  const update = useSettingsStore((s) => s.update);
  return (
    <div className="flex flex-col gap-3">
      <Section>
        <Field
          label={t('settings.remote.unattended.label')}
          hint={t('settings.remote.unattended.hint')}
        >
          <Segmented
            value={skip ? 'on' : 'off'}
            options={onOffOptions}
            onChange={(value) =>
              void update({ server: { skipApprovals: value === 'on' } })
            }
          />
        </Field>
      </Section>
      {skip ? (
        <div className="flex gap-2.5 rounded-lg bg-warning-subtle px-4 py-3">
          <TriangleAlert
            size={16}
            className="mt-0.5 shrink-0 text-warning"
            aria-hidden
          />
          <p className="text-caption text-fg-secondary leading-relaxed">
            {t('settings.remote.unattended.warningBefore')}
            <span className="text-fg-primary">
              {t('settings.remote.unattended.warningReadOnly')}
            </span>
            {t('settings.remote.unattended.warningAfter')}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function LocalServerReach() {
  const { t } = useI18n();
  const [status, setStatus] = useState<ServerStatus>({
    running: false,
    port: null,
    candidates: [],
  });

  useEffect(() => {
    let alive = true;
    void window.marudesk.invoke('server:status').then((next) => {
      if (alive) setStatus(next);
    });
    return () => {
      alive = false;
    };
  }, []);
  useIpcListener('server:status-changed', setStatus);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2.5 rounded-lg bg-warning-subtle px-4 py-3">
        <TriangleAlert
          size={16}
          className="mt-0.5 shrink-0 text-warning"
          aria-hidden
        />
        <p className="text-caption text-fg-secondary leading-relaxed">
          {t('settings.remote.reach.warningBefore')}
          <span className="text-fg-primary">Tailscale</span>
          {t('settings.remote.reach.warningAfter')}
        </p>
      </div>

      <Section>
        <div className="flex flex-col gap-2 px-4 py-3">
          <span className="text-body-sm text-fg-primary">
            {t('settings.remote.reach.title')}
          </span>
          {status.running && status.candidates.length > 0 ? (
            <ul className="flex flex-col gap-1.5">
              {status.candidates.map((candidate) => (
                <li
                  key={candidate.url}
                  className="flex items-center justify-between gap-3 rounded-md bg-surface-page px-3 py-2"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="text-caption text-fg-tertiary">
                      {candidate.label}
                    </span>
                    <span className="truncate font-mono text-body-sm text-fg-secondary">
                      {candidate.url}
                    </span>
                  </div>
                  <CopyUrlButton url={candidate.url} />
                </li>
              ))}
            </ul>
          ) : status.running ? (
            <span className="text-caption text-fg-tertiary">
              {t('settings.remote.reach.none')}
            </span>
          ) : (
            <span className="text-caption text-fg-tertiary">
              {t('settings.remote.reach.starting')}
            </span>
          )}
        </div>
      </Section>
    </div>
  );
}

function CopyUrlButton({ url }: { readonly url: string }) {
  const { t } = useI18n();
  return (
    <CopyButton
      text={url}
      label={`${t('settings.remote.reach.copyBefore')}${url}`}
      size="md"
      write={(text) => window.marudesk.invoke('clipboard:write-text', text)}
    />
  );
}
