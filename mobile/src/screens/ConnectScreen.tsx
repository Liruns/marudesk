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

/**
 * Connect screen. Two ways in:
 *  1. PAIR WITH A PC (T2 direct) — scan the QR shown in the PC's Settings → Remote
 *     (or paste its data), which runs the encrypted handshake and drops you into
 *     chat. This is the primary path: no account, end-to-end encrypted.
 *  2. CLOUD RELAY (Model B) — point at a relay URL and sign in, for use across
 *     networks without Tailscale. Kept below as the alternative.
 */
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
    else if (!isNativeScanAvailable()) setPasteOpen(true);
  };

  const onPaste = async () => {
    if (pasteText.trim()) await pairWithQr(pasteText, deviceName);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 'calc(var(--safe-top) + 40px) 22px 22px',
          display: 'flex',
          flexDirection: 'column',
          gap: 22,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, textAlign: 'center' }}>
          <Brand size={48} />
          <p className="muted" style={{ margin: 0, fontSize: 15, maxWidth: 320 }}>
            Control your PC&apos;s AI agent from your phone.
          </p>
        </div>

        {/* ── Pair with a PC (T2 direct) ─────────────────────────────────────── */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            padding: 16,
            border: '1px solid var(--border)',
            borderRadius: 14,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Smartphone size={18} />
            <strong style={{ fontSize: 15 }}>Pair with your PC</strong>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            On the PC, open Settings → Remote, turn on phone access, then tap “Pair a device”
            to show a QR. Scan it here (or paste the code shown under it). Both devices need
            the same Wi-Fi/LAN, or Tailscale on both.
          </p>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
            After you scan, approve the request back on the PC — not here. You’ll see this
            phone’s name and a short fingerprint there to confirm it’s really you. Then the
            link is end-to-end encrypted, even on open Wi-Fi.
          </p>

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
              className="btn-ghost"
              style={{ fontSize: 13, padding: 0, fontWeight: 600, alignSelf: 'center' }}
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
                style={{ minHeight: 72, resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
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
            <span style={{ color: 'var(--danger)', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <AlertTriangle size={14} /> {authError}
            </span>
          ) : null}
        </div>

        {/* ── Cloud relay (Model B) ──────────────────────────────────────────── */}
        <details>
          <summary className="muted" style={{ fontSize: 13, cursor: 'pointer' }}>
            Use a cloud relay instead
          </summary>
          <div className="field" style={{ marginTop: 12 }}>
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
              <button className="btn-ghost" style={{ fontSize: 13, padding: 0, fontWeight: 600 }} onClick={() => void onTest()}>
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

/** Whether a native barcode scanner plugin is present (else we fall back to paste). */
function isNativeScanAvailable(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return Boolean(cap?.isNativePlatform?.());
}

/**
 * Scan a QR with the device camera via the optional barcode plugin. Loaded through a
 * runtime-resolved specifier (`@vite-ignore`) so the web/dev build doesn't require
 * the native plugin; it resolves on a Capacitor build once `@capacitor-mlkit/
 * barcode-scanning` is installed + `cap sync`'d. Returns the raw QR text, or null
 * (no plugin / cancelled / denied) so the caller can offer the paste fallback.
 */
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
