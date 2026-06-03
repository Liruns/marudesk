import { Loader2, Wifi, WifiOff, AlertTriangle, CircleDot, Zap } from 'lucide-react';
import type { AgentStatus } from '../types';
import type { TransportStatusInfo } from '../transport';

/** Per-status label + color for the agent lifecycle pill. */
const AGENT_META: Record<AgentStatus, { label: string; color: string; pulse?: boolean }> = {
  idle: { label: 'Idle', color: 'var(--fg-faint)' },
  thinking: { label: 'Thinking', color: 'var(--thinking)', pulse: true },
  working: { label: 'Working', color: 'var(--accent)', pulse: true },
  waiting_for_user: { label: 'Waiting for you', color: 'var(--warn)' },
  failed: { label: 'Failed', color: 'var(--danger)' },
  completed: { label: 'Done', color: 'var(--ok)' },
};

/** The agent lifecycle pill shown in the Chat header. */
export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  const meta = AGENT_META[status];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        fontWeight: 600,
        color: meta.color,
      }}
    >
      <CircleDot
        size={12}
        style={meta.pulse ? { animation: 'blink 1.2s ease-in-out infinite' } : undefined}
      />
      {meta.label}
    </span>
  );
}

/** A compact connection chip (relay/PC reachability) for headers + Account. */
export function ConnectionChip({ info }: { info: TransportStatusInfo }) {
  let icon = <Wifi size={14} />;
  let label = 'Connected';
  let color = 'var(--ok)';

  if (info.status === 'connecting') {
    icon = <Loader2 size={14} className="spin" />;
    label = 'Connecting';
    color = 'var(--fg-muted)';
  } else if (info.status === 'connected') {
    if (info.hostOnline) {
      // Distinguish a direct P2P channel (traffic bypasses the cloud) from
      // relay-only — a Zap for the fast path, plain Wi-Fi for the relay.
      color = 'var(--ok)';
      if (info.p2p) {
        icon = <Zap size={14} />;
        label = 'PC · direct';
      } else {
        label = 'PC · relay';
      }
    } else {
      icon = <CircleDot size={14} />;
      label = 'Waiting for PC';
      color = 'var(--warn)';
    }
  } else if (info.status === 'disconnected') {
    icon = <WifiOff size={14} />;
    label = 'Disconnected';
    color = 'var(--fg-faint)';
  } else if (info.status === 'error') {
    icon = <AlertTriangle size={14} />;
    label = 'Error';
    color = 'var(--danger)';
  } else {
    icon = <WifiOff size={14} />;
    label = 'Offline';
    color = 'var(--fg-faint)';
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color }}>
      {icon}
      {label}
    </span>
  );
}
