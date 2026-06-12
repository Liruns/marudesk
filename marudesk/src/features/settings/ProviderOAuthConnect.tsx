import { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Globe,
  Loader2,
  LogIn,
} from 'lucide-react';
import type { BuiltinProviderId } from '../../../shared/providers';
import { Button, CopyButton } from '../../components/ui';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { useProvidersStore } from '../providers/store';
import { useTabsStore } from '../tabs/store';
import { providerFriendlyName } from './providerSettingsFormat';

type ProviderOAuthConnectProps = {
  readonly providerId: BuiltinProviderId;
  readonly connected: boolean;
};

/**
 * Fallback affordances next to the authorize link: copy the URL, or open it in
 * an in-app browser tab — the rescue paths when the OS browser handoff fails
 * (no/broken default browser) or the opened window is buried behind the app.
 */
function OAuthLinkActions({ url }: { url: string }) {
  const { t } = useI18n();
  const newTab = useTabsStore((s) => s.newTab);
  return (
    <div className="flex items-center gap-1">
      <CopyButton
        text={url}
        size="md"
        label={t('settings.providers.oauth.copyUrl')}
        write={(text) => window.marudesk.invoke('clipboard:write-text', text)}
      />
      <Button
        variant="ghost"
        size="sm"
        leadingIcon={<Globe size={13} />}
        onClick={() => void newTab('web', url)}
      >
        {t('settings.providers.oauth.openInApp')}
      </Button>
    </div>
  );
}

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

  const [phase, setPhase] = useState<'idle' | 'manual' | 'waiting' | 'device-code'>('idle');
  const [url, setUrl] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  // The OS refused to open the browser (auth:oauth-start returned opened:false)
  // — lead with the manual link + copy/in-app affordances instead.
  const [openFailed, setOpenFailed] = useState(false);
  const [userCode, setUserCode] = useState<string | null>(null);
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
    setOpenFailed(false);
    setUserCode(null);
  };

  const begin = async () => {
    const started = await startOAuth(providerId);
    if (!started) return;
    setUrl(started.url);
    setOpenFailed(!started.opened);
    if (started.flow === 'device-code') {
      setUserCode(started.userCode ?? null);
      setPhase('device-code');
      const ok = await completeOAuth(providerId);
      if (ok) reset();
      else setPhase('idle');
    } else if (started.flow === 'loopback') {
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
        {phase === 'waiting' || phase === 'device-code' ? (
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

      {phase === 'device-code' ? (
        <div className="flex flex-col gap-2">
          {openFailed && url ? (
            <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-subtle/30 px-3 py-2 text-caption text-fg-secondary">
              <AlertCircle size={13} className="mt-0.5 shrink-0 text-warning" />
              <span>{t('settings.providers.oauth.deviceCode.openFailed')}</span>
            </div>
          ) : null}
          {userCode ? (
            <div className="flex items-center gap-3 rounded-md bg-surface-raised border border-default px-4 py-3">
              <span className="text-caption text-fg-tertiary">{t('settings.providers.oauth.deviceCode.yourCode')}</span>
              <code className="text-heading-md font-mono font-bold text-fg-primary tracking-widest select-all">
                {userCode}
              </code>
              <CopyButton
                text={userCode}
                size="md"
                label={t('settings.providers.oauth.deviceCode.copyCode')}
                write={(text) => window.marudesk.invoke('clipboard:write-text', text)}
              />
            </div>
          ) : null}
          <p className="text-caption text-fg-tertiary flex items-center gap-1.5 flex-wrap">
            <Loader2 size={12} className="animate-spin shrink-0" />
            {t('settings.providers.oauth.deviceCode.waiting')}
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
          {url ? <OAuthLinkActions url={url} /> : null}
        </div>
      ) : phase === 'waiting' ? (
        <div className="flex flex-col gap-2">
          {openFailed ? (
            <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-subtle/30 px-3 py-2 text-caption text-fg-secondary">
              <AlertCircle size={13} className="mt-0.5 shrink-0 text-warning" />
              <span>{t('settings.providers.oauth.openFailed')}</span>
            </div>
          ) : null}
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
          {url ? <OAuthLinkActions url={url} /> : null}
        </div>
      ) : phase === 'manual' && url ? (
        <div className="flex flex-col gap-2">
          {openFailed ? (
            <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-subtle/30 px-3 py-2 text-caption text-fg-secondary">
              <AlertCircle size={13} className="mt-0.5 shrink-0 text-warning" />
              <span>{t('settings.providers.oauth.openFailed')}</span>
            </div>
          ) : null}
          <p className="text-caption text-fg-tertiary">
            {openFailed ? null : (
              <>{t('settings.providers.oauth.manualBefore')} </>
            )}
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
          <OAuthLinkActions url={url} />
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
