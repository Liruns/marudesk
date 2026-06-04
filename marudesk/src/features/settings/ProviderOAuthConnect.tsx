import { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  LogIn,
} from 'lucide-react';
import type { BuiltinProviderId } from '../../../shared/providers';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { useProvidersStore } from '../providers/store';
import { providerFriendlyName } from './providerSettingsFormat';

type ProviderOAuthConnectProps = {
  readonly providerId: BuiltinProviderId;
  readonly connected: boolean;
};

export function ProviderOAuthConnect({
  providerId,
  connected,
}: ProviderOAuthConnectProps) {
  const { t } = useI18n();
  const busy = useProvidersStore((s) => s.oauthBusy);
  const error = useProvidersStore((s) => s.oauthError);
  const startOAuth = useProvidersStore((s) => s.startOAuth);
  const completeOAuth = useProvidersStore((s) => s.completeOAuth);
  const cancelOAuth = useProvidersStore((s) => s.cancelOAuth);
  const disconnectOAuth = useProvidersStore((s) => s.disconnectOAuth);
  const testConn = useProvidersStore((s) => s.testProviderConnection);

  const [phase, setPhase] = useState<'idle' | 'manual' | 'waiting'>('idle');
  const [url, setUrl] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [test, setTest] = useState<{
    status: 'idle' | 'testing' | 'ok' | 'error';
    message: string | null;
  }>({ status: 'idle', message: null });
  const friendly = providerFriendlyName(providerId);

  const runTest = async () => {
    setTest({ status: 'testing', message: null });
    const result = await testConn(providerId);
    setTest({
      status: result.ok ? 'ok' : 'error',
      message: result.message,
    });
  };

  const reset = () => {
    setPhase('idle');
    setUrl(null);
    setPasted('');
  };

  const begin = async () => {
    const started = await startOAuth(providerId);
    if (!started) return;
    setUrl(started.url);
    if (started.flow === 'loopback') {
      setPhase('waiting');
      const ok = await completeOAuth(providerId);
      if (ok) reset();
      else setPhase('idle');
    } else {
      setPhase('manual');
    }
  };

  const finish = async () => {
    if (pasted.trim().length === 0 || busy) return;
    if (await completeOAuth(providerId, pasted.trim())) reset();
  };

  const cancel = async () => {
    await cancelOAuth(providerId);
    reset();
  };

  const field =
    'h-9 w-full rounded-md bg-surface-page border border-default px-3 font-mono text-body-sm text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:border-accent transition-colors duration-fast';
  const errorBox = error ? (
    <div className="text-body-sm text-fg-secondary bg-error-subtle/40 rounded-md px-3 py-2 break-words">
      {error}
    </div>
  ) : null;

  if (connected) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-subtle bg-surface-page/60 px-3 py-2.5">
        <div className="flex items-center gap-2 flex-wrap">
          <CheckCircle2 size={14} className="text-success shrink-0" />
          <span className="text-body-sm text-fg-primary">
            {t('settings.providers.oauth.connectedBefore')}
            {friendly}
            {t('settings.providers.oauth.connectedAfter')}
          </span>
          <span className="flex-1" />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void runTest()}
            disabled={busy || test.status === 'testing'}
          >
            {test.status === 'testing'
              ? t('settings.providers.testing')
              : t('settings.providers.testConnection')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void disconnectOAuth(providerId)}
            disabled={busy}
          >
            {t('settings.providers.oauth.disconnect')}
          </Button>
        </div>
        <p className="text-caption text-fg-tertiary">
          {t('settings.providers.oauth.agentUsesBefore')}
          {friendly}
          {t('settings.providers.oauth.agentUsesAfter')}
        </p>
        {test.status === 'ok' || test.status === 'error' ? (
          <div
            className={cn(
              'flex items-start gap-2 rounded-md px-3 py-2 text-body-sm break-words',
              test.status === 'ok'
                ? 'bg-success-subtle/40 text-fg-secondary'
                : 'bg-error-subtle/40 text-fg-secondary',
            )}
          >
            {test.status === 'ok' ? (
              <CheckCircle2 size={14} className="text-success shrink-0 mt-0.5" />
            ) : (
              <AlertCircle size={14} className="text-error shrink-0 mt-0.5" />
            )}
            <span>{test.message}</span>
          </div>
        ) : null}
        {errorBox}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-subtle bg-surface-page/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-caption uppercase tracking-wider text-fg-tertiary">
          {t('settings.providers.oauth.title')}
        </span>
        <span className="flex-1" />
        {phase === 'waiting' ? (
          <Button variant="ghost" size="sm" onClick={() => void cancel()}>
            {t('settings.providers.cancel')}
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void begin()}
            disabled={busy}
          >
            <LogIn size={13} className="mr-1.5" />
            {busy
              ? t('settings.providers.oauth.opening')
              : phase === 'manual'
                ? t('settings.providers.oauth.reopenSignIn')
                : `${t('settings.providers.oauth.connectWithBefore')}${friendly}${t(
                    'settings.providers.oauth.connectWithAfter',
                  )}`}
          </Button>
        )}
      </div>

      {phase === 'waiting' ? (
        <p className="text-caption text-fg-tertiary flex items-center gap-1.5 flex-wrap">
          <Loader2 size={12} className="animate-spin shrink-0" />
          {t('settings.providers.oauth.waiting')}
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-accent hover:underline"
            >
              {t('settings.providers.oauth.reopen')} <ExternalLink size={11} />
            </a>
          ) : null}
        </p>
      ) : phase === 'manual' && url ? (
        <div className="flex flex-col gap-2">
          <p className="text-caption text-fg-tertiary">
            {t('settings.providers.oauth.manualBefore')}{' '}
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-accent hover:underline"
            >
              {t('settings.providers.oauth.didntOpen')}{' '}
              <ExternalLink size={11} />
            </a>
          </p>
          <input
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void finish();
            }}
            spellCheck={false}
            autoComplete="off"
            placeholder={t('settings.providers.oauth.pastePlaceholder')}
            className={field}
          />
          <div>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void finish()}
              disabled={busy || pasted.trim().length === 0}
            >
              {busy
                ? t('settings.providers.oauth.connecting')
                : t('settings.providers.oauth.finishConnecting')}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-caption text-fg-tertiary">
          {t('settings.providers.oauth.signInAccountBefore')}
          {friendly}
          {t('settings.providers.oauth.signInAccountAfter')}
        </p>
      )}

      {errorBox}
    </div>
  );
}
