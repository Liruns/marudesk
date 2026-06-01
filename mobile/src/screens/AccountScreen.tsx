import { ArrowLeft, LogOut, RefreshCw, Server, User, Cpu } from 'lucide-react';
import { Screen } from '../components/Screen';
import { ConnectionChip } from '../components/StatusBadge';
import { GoogleMark, GitHubMark } from '../components/ProviderMarks';
import { useAppStore } from '../store/useAppStore';

/** Step 4 — logged-in account, relay/PC connection status, reconnect, logout. */
export function AccountScreen() {
  const account = useAppStore((s) => s.account);
  const relayUrl = useAppStore((s) => s.relayUrl);
  const status = useAppStore((s) => s.status);
  const logout = useAppStore((s) => s.logout);
  const reconnect = useAppStore((s) => s.reconnect);
  const setRoute = useAppStore((s) => s.setRoute);

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
              borderRadius: '50%',
              background: 'var(--accent-soft)',
              color: 'var(--accent)',
              display: 'grid',
              placeItems: 'center',
              flexShrink: 0,
            }}
          >
            <MethodIcon method={account?.method} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {account?.displayName || account?.email || 'Signed in'}
            </div>
            <div className="muted" style={{ fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {account?.email}
            </div>
            <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
              via {account?.method ?? 'local'}
            </div>
          </div>
        </div>

        {/* connection card */}
        <div className="card" style={{ padding: 4 }}>
          <Row icon={<Server size={18} />} label="Relay">
            <span className="muted" style={{ fontSize: 13.5, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {relayUrl}
            </span>
          </Row>
          <Divider />
          <Row icon={<Cpu size={18} />} label="PC host">
            <ConnectionChip info={status} />
          </Row>
        </div>

        {status.status === 'error' && status.detail && (
          <div className="faint" style={{ fontSize: 13, padding: '0 4px' }}>{status.detail}</div>
        )}

        <button className="btn btn-secondary btn-block" onClick={() => void reconnect()}>
          <RefreshCw size={18} /> Reconnect
        </button>

        <button className="btn btn-danger btn-block" onClick={() => void logout()}>
          <LogOut size={18} /> Log out
        </button>
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
      <span style={{ fontWeight: 600, fontSize: 14.5 }}>{label}</span>
      <span style={{ marginLeft: 'auto' }}>{children}</span>
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: 'var(--border)', margin: '0 14px' }} />;
}
