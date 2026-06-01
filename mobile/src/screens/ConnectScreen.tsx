import { useState } from 'react';
import { ArrowRight, Link2, QrCode, Loader2, Check, AlertTriangle } from 'lucide-react';
import { Brand } from '../components/Brand';
import { useAppStore } from '../store/useAppStore';
import { health, normalizeRelayUrl } from '../auth/relayClient';

/**
 * Step 1 — point the app at a relay. Persists the URL and optionally pings
 * `/health` so the user gets immediate "reachable" feedback before logging in.
 * A "Scan QR" affordance is present but stubbed (camera/barcode plugin deferred).
 */
export function ConnectScreen() {
  const relayUrl = useAppStore((s) => s.relayUrl);
  const setRelayUrl = useAppStore((s) => s.setRelayUrl);
  const setRoute = useAppStore((s) => s.setRoute);

  const [url, setUrl] = useState(relayUrl);
  const [probe, setProbe] = useState<'idle' | 'checking' | 'ok' | 'fail'>('idle');

  const onContinue = async () => {
    await setRelayUrl(url);
    setRoute('login');
  };

  const onTest = async () => {
    setProbe('checking');
    const ok = await health(normalizeRelayUrl(url));
    setProbe(ok ? 'ok' : 'fail');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 'calc(var(--safe-top) + 48px) 22px 22px',
          display: 'flex',
          flexDirection: 'column',
          gap: 28,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18, textAlign: 'center' }}>
          <Brand size={52} />
          <p className="muted" style={{ margin: 0, fontSize: 15, maxWidth: 320 }}>
            Control your PC's AI agent from your phone. First, connect to your relay.
          </p>
        </div>

        <div className="field">
          <label htmlFor="relay">Relay URL</label>
          <div style={{ position: 'relative' }}>
            <Link2
              size={18}
              style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-faint)' }}
            />
            <input
              id="relay"
              className="input"
              style={{ paddingLeft: 42 }}
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="http://127.0.0.1:8788"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setProbe('idle');
              }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 22 }}>
            <button className="btn-ghost" style={{ fontSize: 13, padding: 0, fontWeight: 600 }} onClick={onTest}>
              Test connection
            </button>
            {probe === 'checking' && <Loader2 size={14} className="spin muted" />}
            {probe === 'ok' && (
              <span style={{ color: 'var(--ok)', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Check size={14} /> Relay reachable
              </span>
            )}
            {probe === 'fail' && (
              <span style={{ color: 'var(--danger)', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <AlertTriangle size={14} /> Couldn't reach relay
              </span>
            )}
          </div>
        </div>

        <button
          className="btn btn-secondary btn-block"
          onClick={() => {
            // QR pairing is deferred (camera/barcode plugin). Placeholder affordance.
            alert('QR pairing is coming soon. For now, enter the relay URL shown on your PC.');
          }}
        >
          <QrCode size={18} /> Scan QR from PC
        </button>
      </div>

      <div style={{ padding: '12px 22px calc(var(--safe-bottom) + 16px)', borderTop: '1px solid var(--border)' }}>
        <button className="btn btn-primary btn-block" onClick={onContinue} disabled={url.trim().length === 0}>
          Continue <ArrowRight size={18} />
        </button>
      </div>
    </div>
  );
}
