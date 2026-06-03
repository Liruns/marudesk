import { useMemo, useState } from 'react';
import { Sparkles, Trash2, X } from 'lucide-react';
import { cn } from '../../../lib/cn';
import { toast } from '../../../lib/toast';
import { toMessage } from '../../../lib/toMessage';
import { askAgent } from '../../agent/store';
import { useDevtoolsStore, type ThrottlePreset } from '../store';
import type { NetworkEntry } from '../types';

/**
 * Network panel: a request table fed by the `Network.*` event stream, plus a
 * detail pane (headers + on-demand response body via `Network.getResponseBody`
 * — bodies are pull-only and may be evicted, hence the explicit load button).
 * A filter bar (text on URL + resource-type buttons) narrows the table;
 * Disable-cache + throttling are sticky page conditions (store), and a request's
 * context offers Copy-as-cURL.
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

/** Filter-bar resource-type buckets → the CDP resourceType values each admits. */
type TypeFilter = 'all' | 'fetch' | 'js' | 'css' | 'img' | 'font' | 'doc' | 'media' | 'other';
const TYPE_FILTERS: { id: TypeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'fetch', label: 'Fetch/XHR' },
  { id: 'js', label: 'JS' },
  { id: 'css', label: 'CSS' },
  { id: 'img', label: 'Img' },
  { id: 'font', label: 'Font' },
  { id: 'doc', label: 'Doc' },
  { id: 'media', label: 'Media' },
  { id: 'other', label: 'Other' },
];
const KNOWN_TYPES = new Set(['fetch', 'js', 'css', 'img', 'font', 'doc', 'media']);

/** Map a CDP resourceType to its filter bucket. */
function typeBucket(resourceType: string | undefined): Exclude<TypeFilter, 'all'> {
  switch (resourceType) {
    case 'XHR':
    case 'Fetch':
    case 'EventSource':
      return 'fetch';
    case 'Script':
      return 'js';
    case 'Stylesheet':
      return 'css';
    case 'Image':
      return 'img';
    case 'Font':
      return 'font';
    case 'Document':
      return 'doc';
    case 'Media':
      return 'media';
    default:
      return 'other';
  }
}

const THROTTLE_OPTIONS: { id: ThrottlePreset; label: string }[] = [
  { id: 'online', label: 'No throttling' },
  { id: 'fast3g', label: 'Fast 3G' },
  { id: 'slow3g', label: 'Slow 3G' },
  { id: 'offline', label: 'Offline' },
];

/**
 * Build a `curl` command line for a request from its method/url/headers
 * (client-side; the request body isn't captured). Single-quotes are escaped for
 * a POSIX shell. Display/copy only — not executed.
 */
function buildCurl(entry: NetworkEntry): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const parts = [`curl ${q(entry.url)}`];
  if (entry.method && entry.method !== 'GET') parts.push(`-X ${entry.method}`);
  for (const [k, v] of Object.entries(entry.requestHeaders ?? {})) {
    // Skip pseudo-headers (HTTP/2 `:method`, `:path`, …) — not valid curl -H.
    if (k.startsWith(':')) continue;
    parts.push(`-H ${q(`${k}: ${v}`)}`);
  }
  return parts.join(' \\\n  ');
}

/** A request worth handing to the agent: a transport failure or a 4xx/5xx response. */
function isFailure(entry: NetworkEntry): boolean {
  return entry.failed === true || (entry.status !== undefined && entry.status >= 400);
}

/**
 * Seed an agent turn with the one failed request's identity (method/url/status)
 * so it targets the right entry, then hand off to its own `read_network` /
 * `read_network_body` tools to pull headers + body and find the root cause —
 * mirroring the console "Fix this" flow (which leans on `get_console_errors`).
 */
function buildNetworkFixPrompt(entry: NetworkEntry): string {
  const outcome = entry.failed
    ? `failed at the transport level${entry.errorText ? ` (${entry.errorText})` : ''}`
    : `returned ${entry.status ?? '?'}${entry.statusText ? ` ${entry.statusText}` : ''}`;
  return (
    `A network request on the running page is broken and needs fixing.\n` +
    `  ${entry.method ?? 'GET'} ${entry.url}\n` +
    `  Outcome: ${outcome}\n\n` +
    `Use read_network (and read_network_body for this request) to inspect the ` +
    `actual response/headers, find the root cause in the workspace source — the ` +
    `client call site or the server/handler — fix it, then reload and verify the ` +
    `request succeeds.`
  );
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

/** A compact timing breakdown: the major phases as labelled bars. */
function TimingBars({ entry }: { entry: NetworkEntry }) {
  const t = entry.timing;
  if (!t) {
    // No CDP timing (cache hit / failed early) — fall back to the total wall time.
    if (entry.endTime === undefined) {
      return <div className="text-caption text-fg-tertiary px-2">No timing data.</div>;
    }
    const total = (entry.endTime - entry.startTime) * 1000;
    return (
      <div className="font-mono text-caption px-2 text-fg-secondary">
        Total: {total.toFixed(1)} ms
      </div>
    );
  }
  // Phase windows as [label, startMs, endMs] relative to requestTime; skip
  // phases that didn't occur (CDP marks them -1) or are zero-width.
  const allPhases: [string, number, number][] = [
    ['DNS', t.dnsStart, t.dnsEnd],
    ['Connect', t.connectStart, t.connectEnd],
    ['SSL', t.sslStart, t.sslEnd],
    ['Send', t.sendStart, t.sendEnd],
    ['Wait (TTFB)', t.sendEnd, t.receiveHeadersEnd],
  ];
  const phases = allPhases.filter(([, s, e]) => s >= 0 && e >= 0 && e > s);
  // Total end: prefer the response receiveHeadersEnd extended to loadingFinished.
  const endMs =
    entry.endTime !== undefined
      ? (entry.endTime - t.requestTime) * 1000
      : t.receiveHeadersEnd;
  const scale = endMs > 0 ? 100 / endMs : 0;
  return (
    <div className="flex flex-col gap-1 px-2">
      {phases.map(([label, s, e]) => (
        <div key={label} className="flex items-center gap-2 text-caption">
          <span className="w-24 shrink-0 text-fg-tertiary">{label}</span>
          <div className="flex-1 h-2.5 bg-surface-2 rounded-sm relative overflow-hidden">
            <div
              className="absolute top-0 h-full bg-accent/60 rounded-sm"
              style={{ left: `${s * scale}%`, width: `${Math.max(1, (e - s) * scale)}%` }}
            />
          </div>
          <span className="w-16 shrink-0 text-right tabular-nums text-fg-secondary">
            {(e - s).toFixed(1)} ms
          </span>
        </div>
      ))}
      <div className="font-mono text-caption text-fg-tertiary pt-0.5">
        Total: {endMs.toFixed(1)} ms
      </div>
    </div>
  );
}

function Initiator({ initiator }: { initiator: NetworkEntry['initiator'] }) {
  if (!initiator) {
    return <div className="text-caption text-fg-tertiary px-2">(unknown)</div>;
  }
  const top = initiator.stack?.callFrames?.[0];
  return (
    <div className="font-mono text-caption px-2 flex flex-col gap-0.5 break-words">
      <div>
        <span className="text-fg-tertiary">Type: </span>
        <span className="text-fg-secondary">{initiator.type}</span>
      </div>
      {initiator.url ? (
        <div>
          <span className="text-fg-tertiary">URL: </span>
          <span className="text-fg-secondary">
            {initiator.url}
            {initiator.lineNumber !== undefined ? `:${initiator.lineNumber + 1}` : ''}
          </span>
        </div>
      ) : null}
      {top ? (
        <div>
          <span className="text-fg-tertiary">Script: </span>
          <span className="text-fg-secondary">
            {(top.functionName || '(anonymous)') + ` @ ${top.url}:${top.lineNumber + 1}`}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function Detail({ entry, onClose }: { entry: NetworkEntry; onClose: () => void }) {
  // The agent chat lives in the main window; hide the hand-off in the popout.
  const windowMode = useDevtoolsStore((s) => s.windowMode);
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

  const copyCurl = async () => {
    try {
      await navigator.clipboard.writeText(buildCurl(entry));
      toast({ title: 'Copied as cURL', variant: 'success' });
    } catch (err) {
      toast({ title: 'Copy failed', description: toMessage(err), variant: 'error' });
    }
  };

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="shrink-0 h-7 flex items-center justify-between gap-2 px-2 border-b border-subtle">
        <span className="text-caption text-fg-primary truncate font-mono">
          {fileName(entry.url)}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {!windowMode && isFailure(entry) ? (
            <button
              type="button"
              onClick={() => void askAgent(buildNetworkFixPrompt(entry))}
              title="Ask AI to fix this request"
              className="h-5 px-1.5 rounded inline-flex items-center gap-1 text-caption text-accent hover:bg-accent-subtle/40 transition-colors duration-fast"
            >
              <Sparkles size={11} />
              Fix this
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void copyCurl()}
            title="Copy as cURL"
            className="h-5 px-1.5 rounded text-caption text-fg-tertiary hover:text-fg-primary hover:bg-surface-2"
          >
            Copy as cURL
          </button>
          <button
            type="button"
            aria-label="Close detail"
            onClick={onClose}
            className="size-5 rounded flex items-center justify-center text-fg-tertiary hover:text-fg-primary"
          >
            <X size={13} />
          </button>
        </div>
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
        <Section title="Timing">
          <TimingBars entry={entry} />
        </Section>
        <Section title="Initiator">
          <Initiator initiator={entry.initiator} />
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
  const cacheDisabled = useDevtoolsStore((s) => s.cacheDisabled);
  const throttle = useDevtoolsStore((s) => s.throttle);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [type, setType] = useState<TypeFilter>('all');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q && type === 'all') return requests;
    return requests.filter((r) => {
      if (q && !r.url.toLowerCase().includes(q)) return false;
      if (type === 'all') return true;
      const bucket = typeBucket(r.resourceType);
      // "Other" catches unknown buckets too (e.g. WebSocket, Manifest, Ping).
      return type === 'other' ? !KNOWN_TYPES.has(bucket) : bucket === type;
    });
  }, [requests, query, type]);

  const selected = requests.find((r) => r.requestId === selectedId) ?? null;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 flex items-center px-1.5 py-1 border-b border-subtle gap-2 flex-wrap">
        <button
          type="button"
          aria-label="Clear network log"
          title="Clear network log"
          onClick={() => {
            useDevtoolsStore.getState().clearNetwork();
            setSelectedId(null);
          }}
          className="size-6 shrink-0 rounded flex items-center justify-center text-fg-tertiary hover:text-fg-primary hover:bg-surface-2"
        >
          <Trash2 size={14} />
        </button>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          placeholder="Filter URL"
          aria-label="Filter requests by URL"
          className="h-6 w-28 min-w-0 rounded bg-surface-2 px-2 text-caption text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:ring-1 focus:ring-accent/50"
        />
        <div className="flex items-center gap-0.5 flex-wrap">
          {TYPE_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={type === f.id}
              onClick={() => setType(f.id)}
              className={cn(
                'h-6 px-1.5 rounded text-caption transition-colors duration-fast',
                type === f.id
                  ? 'bg-surface-page text-fg-primary'
                  : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-2',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1 text-caption text-fg-tertiary cursor-pointer select-none whitespace-nowrap">
            <input
              type="checkbox"
              checked={cacheDisabled}
              onChange={(e) => useDevtoolsStore.getState().setCacheDisabled(e.target.checked)}
              className="accent-accent"
            />
            Disable cache
          </label>
          <select
            value={throttle}
            onChange={(e) =>
              useDevtoolsStore.getState().setThrottle(e.target.value as ThrottlePreset)
            }
            aria-label="Network throttling"
            className="h-6 rounded bg-surface-2 px-1 text-caption text-fg-secondary focus:outline-none focus:ring-1 focus:ring-accent/50"
          >
            {THROTTLE_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex-[3] min-h-0 overflow-auto">
        {requests.length === 0 ? (
          <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
            Recording network activity…
          </div>
        ) : visible.length === 0 ? (
          <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
            No matching requests
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
              {visible.map((r) => (
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
