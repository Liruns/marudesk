import { useState } from 'react';
import {
  ArrowRight,
  Link2,
  Loader2,
  QrCode,
  Smartphone,
  AlertTriangle,
} from 'lucide-react';
import { Brand } from '../components/Brand';
import { useAppStore } from '../store/useAppStore';
import { health, normalizeRelayUrl } from '../auth/relayClient';

export function ConnectScreen() {
  const relayUrl = useAppStore((s) => s.relayUrl);
  const setRelayUrl = useAppStore((s) => s.setRelayUrl);
  const setRoute = useAppStore((s) => s.setRoute);
  const pairWithQr = useAppStore((s) => s.pairWithQr);
  const busy = useAppStore((s) => s.busy);
  const authError = useAppStore((s) => s.authError);

  const [url, setUrl] = useState(relayUrl);
  const [probe, setProbe] = useState<'idle' | 'checking' | 'ok' | 'fail'>('idle');
  const [deviceName, setDeviceName] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');

  const onContinue = async () => {
    await setRelayUrl(url);
    setRoute('login');
  };

  const onTest = async () => {
    setProbe('checking');
    const ok = await health(normalizeRelayUrl(url));
    setProbe(ok ? 'ok' : 'fail');
  };

  const onScan = async () => {
    const scanned = await scanQr();
    if (scanned) await pairWithQr(scanned, deviceName);
    else setPasteOpen(true);
  };

  const onPaste = async () => {
    if (pasteText.trim()) await pairWithQr(pasteText, deviceName);
  };

  return (
    <div className="connect-screen">
      <div className="connect-scroll">
        <section className="connect-hero">
          <Brand size={48} />
          <p>
            Pair this phone with your desktop agent.
          </p>
        </section>

        <section className="setup-panel">
          <div className="setup-title">
            <Smartphone size={18} />
            <strong style={{ fontSize: 15 }}>Pair with your PC</strong>
          </div>
          <div className="pair-steps">
            <div><span>1</span><p>Open Settings &gt; Remote on the PC.</p></div>
            <div><span>2</span><p>Show the pairing QR.</p></div>
            <div><span>3</span><p>Scan here, then approve on the PC.</p></div>
          </div>

          <div className="field">
            <label htmlFor="devname">Device name (shown on the PC)</label>
            <input
              id="devname"
              className="input"
              autoCapitalize="words"
              spellCheck={false}
              placeholder="My phone"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
            />
          </div>

          <button className="btn btn-primary btn-block" disabled={busy} onClick={() => void onScan()}>
            {busy ? <Loader2 size={18} className="spin" /> : <QrCode size={18} />} Scan QR from PC
          </button>

          {!pasteOpen ? (
            <button
              className="inline-link-button"
              onClick={() => setPasteOpen(true)}
            >
              Or paste the pairing data
            </button>
          ) : (
            <div className="field">
              <label htmlFor="pastedata">Pairing data (from the PC)</label>
              <textarea
                id="pastedata"
                className="input"
                style={{ minHeight: 72, resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 12 }}
                spellCheck={false}
                placeholder="Paste the code shown under the QR on your PC"
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
              />
              <button
                className="btn btn-secondary btn-block"
                disabled={busy || pasteText.trim().length === 0}
                onClick={() => void onPaste()}
              >
                {busy ? <Loader2 size={18} className="spin" /> : null} Pair
              </button>
            </div>
          )}

          {authError ? (
            <span className="error-inline">
              <AlertTriangle size={14} /> {authError}
            </span>
          ) : null}
        </section>

        <details className="relay-details">
          <summary>
            Use a cloud relay instead
          </summary>
          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="relay">Relay URL</label>
            <div className="input-with-icon">
              <Link2
                size={18}
                className="input-icon"
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
            <div className="probe-row">
              <button className="inline-link-button" onClick={() => void onTest()}>
                Test connection
              </button>
              {probe === 'checking' && <Loader2 size={14} className="spin muted" />}
              {probe === 'ok' && <span style={{ color: 'var(--ok)', fontSize: 13 }}>Relay reachable</span>}
              {probe === 'fail' && <span style={{ color: 'var(--danger)', fontSize: 13 }}>Couldn&apos;t reach relay</span>}
            </div>
            <button
              className="btn btn-secondary btn-block"
              style={{ marginTop: 8 }}
              onClick={() => void onContinue()}
              disabled={url.trim().length === 0}
            >
              Continue to sign-in <ArrowRight size={18} />
            </button>
          </div>
        </details>
      </div>
    </div>
  );
}

async function scanQr(): Promise<string | null> {
  const spec = '@capacitor-mlkit/barcode-scanning';
  try {
    const mod = (await import(/* @vite-ignore */ spec)) as {
      BarcodeScanner?: {
        requestPermissions?: () => Promise<unknown>;
        scan?: () => Promise<{ barcodes?: { rawValue?: string }[] }>;
      };
    };
    const scanner = mod.BarcodeScanner;
    if (!scanner?.scan) return null;
    await scanner.requestPermissions?.();
    const result = await scanner.scan();
    return result.barcodes?.[0]?.rawValue ?? null;
  } catch {
    return null;
  }
}
