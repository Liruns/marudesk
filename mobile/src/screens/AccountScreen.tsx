import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Bug, Clipboard, LogOut, RefreshCw, Server, Terminal, User, Cpu, Smartphone, Trash2 } from 'lucide-react';
import { Screen } from '../components/Screen';
import { ConnectionChip } from '../components/StatusBadge';
import { GoogleMark, GitHubMark } from '../components/ProviderMarks';
import { clearDiagnosticLogs, subscribeDiagnosticLogs, type DiagnosticLogEntry } from '../lib/diagnostics';
import { useAppStore } from '../store/useAppStore';

/** Step 4 — account / paired-PC, connection status, reconnect, log out / unpair. */
export function AccountScreen() {
  const account = useAppStore((s) => s.account);
  const relayUrl = useAppStore((s) => s.relayUrl);
  const status = useAppStore((s) => s.status);
  const mode = useAppStore((s) => s.mode);
  const direct = useAppStore((s) => s.direct);
  const logout = useAppStore((s) => s.logout);
  const unpair = useAppStore((s) => s.unpair);
  const reconnect = useAppStore((s) => s.reconnect);
  const setRoute = useAppStore((s) => s.setRoute);
  const developerMode = useAppStore((s) => s.developerMode);
  const setDeveloperMode = useAppStore((s) => s.setDeveloperMode);
  const isDirect = mode === 'direct';
  const [logs, setLogs] = useState<DiagnosticLogEntry[]>([]);

  useEffect(() => subscribeDiagnosticLogs(setLogs), []);

  const report = useMemo(
    () => buildDiagnosticReport({ mode, relayUrl, directUrl: direct?.baseUrl, status, logs }),
    [mode, relayUrl, direct?.baseUrl, status, logs],
  );

  return (
    <Screen
      title="Account"
      left={
        <button className="btn-ghost" style={{ minHeight: 40, padding: 4 }} aria-label="Back" onClick={() => setRoute('chat')}>
          <ArrowLeft size={20} />
        </button>
      }
    >
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* identity card */}
        <div className="card" style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 14 }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 'var(--radius-lg)',
              background: 'var(--accent-soft)',
              color: 'var(--accent)',
              display: 'grid',
              placeItems: 'center',
              flexShrink: 0,
            }}
          >
            {isDirect ? <Smartphone size={22} /> : <MethodIcon method={account?.method} />}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {isDirect ? 'Paired PC' : account?.displayName || account?.email || 'Signed in'}
            </div>
            <div className="muted" style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {isDirect ? direct?.baseUrl : account?.email}
            </div>
            <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
              {isDirect ? 'direct · end-to-end encrypted' : `via ${account?.method ?? 'local'}`}
            </div>
          </div>
        </div>

        {/* connection card */}
        <div className="card" style={{ padding: 4 }}>
          <Row icon={<Server size={18} />} label={isDirect ? 'PC' : 'Relay'}>
            <span className="muted" style={{ fontSize: 13.5, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {isDirect ? direct?.baseUrl : relayUrl}
            </span>
          </Row>
          <Divider />
          <Row icon={<Cpu size={18} />} label={isDirect ? 'Connection' : 'PC host'}>
            <ConnectionChip info={status} />
          </Row>
        </div>

        {status.status === 'error' && status.detail && (
          <div className="faint" style={{ fontSize: 13, padding: '0 4px' }}>{status.detail}</div>
        )}

        <button className="btn btn-secondary btn-block" onClick={() => void reconnect()}>
          <RefreshCw size={18} /> Reconnect
        </button>

        <div className="card" style={{ padding: 4 }}>
          <Row icon={<Bug size={18} />} label="Developer tools">
            <button
              className="btn btn-secondary"
              style={{ minHeight: 34, padding: '0 12px' }}
              onClick={() => void setDeveloperMode(!developerMode)}
            >
              {developerMode ? 'On' : 'Off'}
            </button>
          </Row>
          {developerMode ? (
            <>
              <Divider />
              <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="label-row" style={{ color: 'var(--fg-muted)' }}>
                  <Terminal size={15} />
                  <span style={{ fontSize: 13, fontWeight: 500 }}>Diagnostics</span>
                  <span className="faint" style={{ marginLeft: 'auto', fontSize: 12 }}>{logs.length} logs</span>
                </div>
                <pre className="diagnostic-report">{report}</pre>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <button className="btn btn-secondary" onClick={() => void copyText(report)}>
                    <Clipboard size={16} /> Copy report
                  </button>
                  <button className="btn btn-secondary" onClick={clearDiagnosticLogs}>
                    Clear logs
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </div>

        {isDirect ? (
          <button className="btn btn-danger btn-block" onClick={() => void unpair()}>
            <Trash2 size={18} /> Unpair this PC
          </button>
        ) : (
          <button className="btn btn-danger btn-block" onClick={() => void logout()}>
            <LogOut size={18} /> Log out
          </button>
        )}
      </div>
    </Screen>
  );
}

function MethodIcon({ method }: { method?: 'local' | 'google' | 'github' }) {
  if (method === 'google') return <GoogleMark size={22} />;
  if (method === 'github') return <GitHubMark size={22} />;
  return <User size={22} />;
}

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', minHeight: 'var(--tap)' }}>
      <span style={{ color: 'var(--fg-muted)', display: 'flex' }}>{icon}</span>
      <span style={{ fontWeight: 500, fontSize: 14 }}>{label}</span>
      <span style={{ marginLeft: 'auto' }}>{children}</span>
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: 'var(--border)', margin: '0 14px' }} />;
}

function buildDiagnosticReport(input: {
  mode: string;
  relayUrl: string;
  directUrl?: string;
  status: unknown;
  logs: DiagnosticLogEntry[];
}): string {
  const lines = [
    'marudesk mobile diagnostics',
    `time: ${new Date().toISOString()}`,
    `mode: ${input.mode}`,
    `relayUrl: ${input.relayUrl}`,
    `directUrl: ${input.directUrl ?? '-'}`,
    `status: ${safeJson(input.status)}`,
    `userAgent: ${navigator.userAgent}`,
    `online: ${navigator.onLine}`,
    `viewport: ${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio}`,
    '',
    'recent console:',
    ...input.logs.slice(-80).map((log) => `${new Date(log.at).toISOString()} ${log.level.toUpperCase()} ${log.message}`),
  ];
  return lines.join('\n');
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    // Some WebViews disallow clipboard writes without a user gesture/permission.
    console.info('diagnostic report copy failed');
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

