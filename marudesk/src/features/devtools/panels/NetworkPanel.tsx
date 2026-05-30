import { useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { cn } from '../../../lib/cn';
import { useDevtoolsStore } from '../store';
import type { NetworkEntry } from '../types';

/**
 * Network panel: a request table fed by the `Network.*` event stream, plus a
 * detail pane (headers + on-demand response body via `Network.getResponseBody`
 * — bodies are pull-only and may be evicted, hence the explicit load button).
 */

function fileName(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return (last || u.hostname) + (u.search ? u.search : '');
  } catch {
    return url;
  }
}

function fmtSize(entry: NetworkEntry): string {
  if (entry.fromCache) return '(cache)';
  const n = entry.encodedDataLength;
  if (n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtTime(entry: NetworkEntry): string {
  if (entry.endTime === undefined) return '…';
  const ms = (entry.endTime - entry.startTime) * 1000;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function statusClass(entry: NetworkEntry): string {
  if (entry.failed) return 'text-error';
  if (entry.status === undefined) return 'text-fg-tertiary';
  if (entry.status >= 400) return 'text-error';
  if (entry.status >= 300) return 'text-warning';
  return 'text-fg-secondary';
}

function HeaderList({ headers }: { headers?: Record<string, string> }) {
  if (!headers || Object.keys(headers).length === 0) {
    return <div className="text-caption text-fg-tertiary px-2">(none)</div>;
  }
  return (
    <div className="flex flex-col gap-0.5">
      {Object.entries(headers).map(([k, v]) => (
        <div key={k} className="font-mono text-caption leading-snug px-2 break-words">
          <span className="text-fg-tertiary">{k}: </span>
          <span className="text-fg-secondary">{v}</span>
        </div>
      ))}
    </div>
  );
}

function Detail({ entry, onClose }: { entry: NetworkEntry; onClose: () => void }) {
  const [body, setBody] = useState<string | null>(null);
  const [bodyState, setBodyState] = useState<'idle' | 'loading' | 'empty'>('idle');
  // Reset the loaded body when the selected request changes, using the
  // store-previous-prop pattern (no effect → no cascading render), matching
  // SettingsView's TextField.
  const [reqId, setReqId] = useState(entry.requestId);
  if (reqId !== entry.requestId) {
    setReqId(entry.requestId);
    setBody(null);
    setBodyState('idle');
  }

  const loadBody = async () => {
    setBodyState('loading');
    const res = await useDevtoolsStore.getState().getResponseBody(entry.requestId);
    if (!res) {
      setBodyState('empty');
      return;
    }
    setBody(res.base64Encoded ? '(binary response — not shown)' : res.body);
    setBodyState('idle');
  };

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="shrink-0 h-7 flex items-center justify-between px-2 border-b border-subtle">
        <span className="text-caption text-fg-primary truncate font-mono">
          {fileName(entry.url)}
        </span>
        <button
          type="button"
          aria-label="Close detail"
          onClick={onClose}
          className="size-5 rounded flex items-center justify-center text-fg-tertiary hover:text-fg-primary"
        >
          <X size={13} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto py-2 flex flex-col gap-3">
        <Section title="General">
          <div className="font-mono text-caption px-2 flex flex-col gap-0.5 break-words">
            <div>
              <span className="text-fg-tertiary">Request URL: </span>
              <span className="text-fg-secondary">{entry.url}</span>
            </div>
            <div>
              <span className="text-fg-tertiary">Method: </span>
              <span className="text-fg-secondary">{entry.method}</span>
            </div>
            <div>
              <span className="text-fg-tertiary">Status: </span>
              <span className={statusClass(entry)}>
                {entry.failed
                  ? `(failed) ${entry.errorText ?? ''}`
                  : `${entry.status ?? '—'} ${entry.statusText ?? ''}`}
              </span>
            </div>
            {entry.remoteIPAddress ? (
              <div>
                <span className="text-fg-tertiary">Remote address: </span>
                <span className="text-fg-secondary">{entry.remoteIPAddress}</span>
              </div>
            ) : null}
          </div>
        </Section>
        <Section title="Response headers">
          <HeaderList headers={entry.responseHeaders} />
        </Section>
        <Section title="Request headers">
          <HeaderList headers={entry.requestHeaders} />
        </Section>
        <Section title="Response">
          {bodyState === 'empty' ? (
            <div className="text-caption text-fg-tertiary px-2">
              No body available (evicted from cache).
            </div>
          ) : body !== null ? (
            <pre className="font-mono text-caption text-fg-secondary px-2 whitespace-pre-wrap break-words max-h-64 overflow-auto">
              {body}
            </pre>
          ) : (
            <button
              type="button"
              onClick={() => void loadBody()}
              disabled={bodyState === 'loading'}
              className="mx-2 h-6 px-2 rounded bg-surface-2 text-caption text-fg-secondary hover:text-fg-primary disabled:opacity-50"
            >
              {bodyState === 'loading' ? 'Loading…' : 'Load response body'}
            </button>
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-caption uppercase tracking-wide text-fg-tertiary px-2">
        {title}
      </div>
      {children}
    </div>
  );
}

export function NetworkPanel() {
  const requests = useDevtoolsStore((s) => s.network);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = requests.find((r) => r.requestId === selectedId) ?? null;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 h-8 flex items-center px-1.5 border-b border-subtle gap-2">
        <button
          type="button"
          aria-label="Clear network log"
          title="Clear network log"
          onClick={() => {
            useDevtoolsStore.getState().clearNetwork();
            setSelectedId(null);
          }}
          className="size-6 rounded flex items-center justify-center text-fg-tertiary hover:text-fg-primary hover:bg-surface-2"
        >
          <Trash2 size={14} />
        </button>
        <span className="text-caption text-fg-tertiary tabular-nums">
          {requests.length} requests
        </span>
      </div>

      <div className="flex-[3] min-h-0 overflow-auto">
        {requests.length === 0 ? (
          <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
            Recording network activity…
          </div>
        ) : (
          <table className="w-full text-caption">
            <thead className="sticky top-0 bg-surface-1 text-fg-tertiary">
              <tr className="text-left">
                <th className="font-normal font-mono px-2 py-1">Name</th>
                <th className="font-normal px-1 py-1 w-12">Status</th>
                <th className="font-normal px-1 py-1 w-16">Type</th>
                <th className="font-normal px-1 py-1 w-16 text-right">Size</th>
                <th className="font-normal px-2 py-1 w-16 text-right">Time</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr
                  key={r.requestId}
                  onClick={() => setSelectedId(r.requestId)}
                  className={cn(
                    'cursor-default',
                    r.requestId === selectedId
                      ? 'bg-accent-subtle/50'
                      : 'hover:bg-surface-2',
                  )}
                >
                  <td className="px-2 py-0.5 font-mono text-fg-primary truncate max-w-0">
                    {fileName(r.url)}
                  </td>
                  <td className={cn('px-1 py-0.5 tabular-nums', statusClass(r))}>
                    {r.failed ? 'fail' : (r.status ?? '·')}
                  </td>
                  <td className="px-1 py-0.5 text-fg-tertiary truncate">
                    {r.resourceType ?? '—'}
                  </td>
                  <td className="px-1 py-0.5 text-right text-fg-tertiary tabular-nums">
                    {fmtSize(r)}
                  </td>
                  <td className="px-2 py-0.5 text-right text-fg-tertiary tabular-nums">
                    {fmtTime(r)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected ? (
        <div className="flex-[2] min-h-0 border-t border-subtle">
          <Detail entry={selected} onClose={() => setSelectedId(null)} />
        </div>
      ) : null}
    </div>
  );
}
