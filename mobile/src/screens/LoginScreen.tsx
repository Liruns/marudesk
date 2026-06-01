import { useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Brand } from '../components/Brand';
import { GoogleMark, GitHubMark } from '../components/ProviderMarks';
import { useAppStore } from '../store/useAppStore';
import { oauthStartUrl } from '../auth/relayClient';

type Mode = 'login' | 'signup';

/**
 * Step 2 — auth against the relay. Email/password (login + self-signup) is fully
 * functional; the Google/GitHub buttons start the relay's web OAuth flow by
 * opening `<relay>/auth/<provider>`. If the relay hasn't been configured with
 * provider credentials it returns 503; we surface a "configure on PC/relay"
 * hint rather than failing silently. (The deep-link token return is a B4 item;
 * see design §6.1 M4.)
 */
export function LoginScreen() {
  const relayUrl = useAppStore((s) => s.relayUrl);
  const busy = useAppStore((s) => s.busy);
  const authError = useAppStore((s) => s.authError);
  const login = useAppStore((s) => s.login);
  const signup = useAppStore((s) => s.signup);
  const setRoute = useAppStore((s) => s.setRoute);
  const clearAuthError = useAppStore((s) => s.clearAuthError);

  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [oauthNote, setOauthNote] = useState<string | null>(null);

  const canSubmit = email.trim().length > 3 && password.length >= 8 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    if (mode === 'login') await login(email.trim(), password);
    else await signup(email.trim(), password);
  };

  const startOAuth = (provider: 'google' | 'github') => {
    setOauthNote(null);
    const url = oauthStartUrl(relayUrl, provider);
    // On web/PWA this navigates the browser into the relay's 302 flow. On a
    // native build this should open the system browser + return via a deep link
    // (Capacitor App URL-open) — wired in B4. We open in a new tab/window here.
    const win = window.open(url, '_blank');
    if (!win) {
      setOauthNote(`Open ${url} in your browser to continue, or configure ${provider} OAuth on the relay.`);
    }
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    clearAuthError();
    setOauthNote(null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <header style={{ padding: 'calc(var(--safe-top) + 10px) 14px 4px' }}>
        <button
          className="btn-ghost"
          style={{ minHeight: 40, display: 'inline-flex', alignItems: 'center', gap: 6, padding: 0 }}
          onClick={() => setRoute('connect')}
        >
          <ArrowLeft size={18} /> Relay
        </button>
      </header>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 22px 22px', display: 'flex', flexDirection: 'column', gap: 22 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <Brand size={44} />
        </div>

        {/* segmented login / signup toggle */}
        <div style={{ display: 'flex', background: 'var(--bg-elev-2)', borderRadius: 'var(--radius)', padding: 4, gap: 4 }}>
          {(['login', 'signup'] as const).map((m) => (
            <button
              key={m}
              onClick={() => switchMode(m)}
              className="btn"
              style={{
                flex: 1,
                minHeight: 40,
                fontSize: 14.5,
                background: mode === m ? 'var(--bg-input)' : 'transparent',
                color: mode === m ? 'var(--fg)' : 'var(--fg-muted)',
                border: mode === m ? '1px solid var(--border-strong)' : '1px solid transparent',
              }}
            >
              {m === 'login' ? 'Log in' : 'Sign up'}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              className="input"
              type="email"
              inputMode="email"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              placeholder={mode === 'signup' ? 'At least 8 characters' : '••••••••'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </div>

          {authError && <div className="error-text">{authError}</div>}

          <button className="btn btn-primary btn-block" disabled={!canSubmit} onClick={submit}>
            {busy && <Loader2 size={18} className="spin" />}
            {mode === 'login' ? 'Log in' : 'Create account'}
          </button>
        </div>

        <div className="divider">or continue with</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button className="btn btn-secondary btn-block" onClick={() => startOAuth('google')}>
            <GoogleMark size={18} /> Sign in with Google
          </button>
          <button className="btn btn-secondary btn-block" onClick={() => startOAuth('github')}>
            <GitHubMark size={18} /> Sign in with GitHub
          </button>
          {oauthNote && <div className="faint" style={{ fontSize: 13 }}>{oauthNote}</div>}
        </div>

        <p className="faint" style={{ fontSize: 12.5, textAlign: 'center', margin: 0, lineHeight: 1.5 }}>
          The same account must be logged in on your PC. The relay only brokers your own
          devices — credentials and agent tools stay on the PC.
        </p>
      </div>
    </div>
  );
}
