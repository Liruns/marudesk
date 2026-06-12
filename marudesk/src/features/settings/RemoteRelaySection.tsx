import { useEffect, useState } from 'react';
import type { RelayStatus } from '../../../shared/remote';
import { DEFAULT_RELAY_URL } from '../../../shared/settings';
import { Button } from '../../components/ui';
import { useIpcListener } from '../../hooks';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { Field, Section, Segmented, TextField } from './SettingsControls';
import { useSettingsStore } from './store';
import { useOnOffOptions } from './useLocalizedSettingsOptions';

export function CloudRelaySection() {
  const { t } = useI18n();
  const onOffOptions = useOnOffOptions();
  const server = useSettingsStore((s) => s.settings.server);
  const update = useSettingsStore((s) => s.update);

  const [status, setStatus] = useState<RelayStatus>({ account: null, connected: false });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  // The Google flow waits on the user's browser (minutes, not seconds), so it has
  // its own flag — the email form stays usable and shows a distinct waiting hint.
  const [googleBusy, setGoogleBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initial status + live updates from main (host connect/disconnect, session changes).
  useEffect(() => {
    let alive = true;
    void window.marudesk.invoke('relay:status').then((s) => {
      if (alive) setStatus(s);
    });
    return () => {
      alive = false;
    };
  }, []);
  useIpcListener('relay:status-changed', setStatus);

  const submit = async (mode: 'login' | 'signup'): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await window.marudesk.invoke('relay:login', {
        relayUrl: server.relayUrl,
        email: email.trim(),
        password,
        mode,
      });
      setStatus(next);
      setPassword('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitGoogle = async (): Promise<void> => {
    setGoogleBusy(true);
    setError(null);
    try {
      setStatus(
        await window.marudesk.invoke('relay:login-google', { relayUrl: server.relayUrl }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGoogleBusy(false);
    }
  };

  const logout = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await window.marudesk.invoke('relay:logout'));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const account = status.account;

  return (
    <Section>
      <Field
        label={t('settings.remote.relay.enable.label')}
        hint={t('settings.remote.relay.enable.hint')}
      >
        <Segmented
          value={server.cloudEnabled ? 'on' : 'off'}
          options={onOffOptions}
          onChange={(v) => void update({ server: { cloudEnabled: v === 'on' } })}
        />
      </Field>
      <Field
        label={t('settings.remote.relay.url.label')}
        hint={t('settings.remote.relay.url.hint')}
      >
        <TextField
          value={server.relayUrl}
          placeholder={DEFAULT_RELAY_URL}
          onCommit={(relayUrl) => void update({ server: { relayUrl } })}
        />
      </Field>

      {account ? (
        <Field
          label={t('settings.remote.relay.account.label')}
          hint={
            server.cloudEnabled
              ? status.connected
                ? t('settings.remote.relay.account.connected')
                : t('settings.remote.relay.account.connecting')
              : t('settings.remote.relay.account.loggedIn')
          }
        >
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'inline-block size-2 rounded-full',
                  status.connected ? 'bg-success' : 'bg-fg-tertiary',
                )}
                aria-hidden
              />
              <span className="text-body-sm text-fg-secondary">{account.email}</span>
            </div>
            <Button variant="secondary" disabled={busy} onClick={() => void logout()}>
              {t('settings.remote.relay.logout')}
            </Button>
          </div>
        </Field>
      ) : (
        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="flex flex-col gap-2">
            <input
              type="email"
              value={email}
              placeholder={t('settings.remote.relay.email')}
              autoComplete="username"
              spellCheck={false}
              onChange={(e) => setEmail(e.target.value)}
              className={cn(
                'h-8 w-full rounded-md bg-surface-page border border-default px-3',
                'text-body-sm text-fg-primary placeholder:text-fg-tertiary',
                'focus:outline-none focus:border-accent transition-colors duration-fast',
              )}
            />
            <input
              type="password"
              value={password}
              placeholder={t('settings.remote.relay.password')}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy && email.trim() && password) void submit('login');
              }}
              className={cn(
                'h-8 w-full rounded-md bg-surface-page border border-default px-3',
                'text-body-sm text-fg-primary placeholder:text-fg-tertiary',
                'focus:outline-none focus:border-accent transition-colors duration-fast',
              )}
            />
          </div>
          {error ? <span className="text-caption text-error">{error}</span> : null}
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              disabled={busy || googleBusy || !email.trim() || !password}
              onClick={() => void submit('login')}
            >
              {t('settings.remote.relay.login')}
            </Button>
            <Button
              variant="secondary"
              disabled={busy || googleBusy || !email.trim() || !password}
              onClick={() => void submit('signup')}
            >
              {t('settings.remote.relay.signup')}
            </Button>
            <Button
              variant="secondary"
              disabled={busy || googleBusy}
              onClick={() => void submitGoogle()}
            >
              {googleBusy
                ? t('settings.remote.relay.googleWaiting')
                : t('settings.remote.relay.google')}
            </Button>
          </div>
          <p className="text-caption text-fg-tertiary">
            {t('settings.remote.relay.googleHint')}
          </p>
        </div>
      )}
    </Section>
  );
}
