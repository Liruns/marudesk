import { useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useI18n } from '../../../i18n/useI18n';
import { cn } from '../../../lib/cn';
import { useDevtoolsStore, type ThrottlePreset } from '../store';
import { Detail, SummaryBar, Waterfall } from './NetworkPanel.parts';
import {
  TYPE_FILTERS,
  THROTTLE_OPTIONS,
  KNOWN_TYPES,
  type TypeFilter,
  fileName,
  typeBucket,
  fmtSize,
  fmtTime,
  summarize,
  statusClass,
} from './network-utils';

/**
 * Network panel: a request table fed by the `Network.*` event stream, plus a
 * detail pane (headers + on-demand response body via `Network.getResponseBody`
 * — bodies are pull-only and may be evicted, hence the explicit load button).
 * A filter bar (text on URL + resource-type buttons) narrows the table;
 * Disable-cache + throttling are sticky page conditions (store), and a request's
 * context offers Copy-as-cURL.
 */

export function NetworkPanel() {
  const { t } = useI18n();
  const requests = useDevtoolsStore((s) => s.network);
  const cacheDisabled = useDevtoolsStore((s) => s.cacheDisabled);
  const throttle = useDevtoolsStore((s) => s.throttle);
  const preserveNetworkLog = useDevtoolsStore((s) => s.preserveNetworkLog);
  const navStartTime = useDevtoolsStore((s) => s.navStartTime);
  const domContentTime = useDevtoolsStore((s) => s.domContentTime);
  const loadTime = useDevtoolsStore((s) => s.loadTime);
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

  // Waterfall window: the [earliest start, latest end] across visible requests,
  // so each row's mini-bar is positioned on a shared timeline. `span` is floored
  // to avoid divide-by-zero on a single instantaneous request.
  const wf = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const r of visible) {
      if (r.startTime < min) min = r.startTime;
      const end = r.endTime ?? r.startTime;
      if (end > max) max = end;
    }
    return min < Infinity ? { min, span: Math.max(max - min, 1e-6) } : null;
  }, [visible]);

  const summary = useMemo(
    () => summarize(requests, navStartTime, domContentTime, loadTime),
    [requests, navStartTime, domContentTime, loadTime],
  );

  const selected = requests.find((r) => r.requestId === selectedId) ?? null;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 flex items-center px-1.5 py-1 border-b border-subtle gap-2 flex-wrap">
        <button
          type="button"
          aria-label={t('devtools.network.clearLog')}
          title={t('devtools.network.clearLog')}
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
          placeholder={t('devtools.network.filterUrl')}
          aria-label={t('devtools.network.filterUrlAria')}
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
              {t(f.labelKey)}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1 text-caption text-fg-tertiary cursor-pointer select-none whitespace-nowrap">
            <input
              type="checkbox"
              checked={preserveNetworkLog}
              onChange={(e) =>
                useDevtoolsStore.getState().setPreserveNetworkLog(e.target.checked)
              }
              className="accent-accent"
            />
            {t('devtools.network.preserveLog')}
          </label>
          <label className="flex items-center gap-1 text-caption text-fg-tertiary cursor-pointer select-none whitespace-nowrap">
            <input
              type="checkbox"
              checked={cacheDisabled}
              onChange={(e) => useDevtoolsStore.getState().setCacheDisabled(e.target.checked)}
              className="accent-accent"
            />
            {t('devtools.network.disableCache')}
          </label>
          <select
            value={throttle}
            onChange={(e) =>
              useDevtoolsStore.getState().setThrottle(e.target.value as ThrottlePreset)
            }
            aria-label={t('devtools.network.throttling')}
            className="h-6 rounded bg-surface-2 px-1 text-caption text-fg-secondary focus:outline-none focus:ring-1 focus:ring-accent/50"
          >
            {THROTTLE_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {t(o.labelKey)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex-[3] min-h-0 overflow-auto">
        {requests.length === 0 ? (
          <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
            {t('devtools.network.recording')}
          </div>
        ) : visible.length === 0 ? (
          <div className="h-full flex items-center justify-center text-caption text-fg-tertiary">
            {t('devtools.network.noMatchingRequests')}
          </div>
        ) : (
          <table className="w-full text-caption">
            <thead className="sticky top-0 bg-surface-1 text-fg-tertiary z-10">
              <tr className="text-left">
                <th className="font-normal font-mono px-2 py-1">{t('devtools.application.name')}</th>
                <th className="font-normal px-1 py-1 w-14">{t('devtools.network.method')}</th>
                <th className="font-normal px-1 py-1 w-12">{t('devtools.network.status')}</th>
                <th className="font-normal px-1 py-1 w-16">{t('devtools.network.type')}</th>
                <th className="font-normal px-1 py-1 w-16 text-right">{t('devtools.network.size')}</th>
                <th className="font-normal px-2 py-1 w-16 text-right">{t('devtools.network.time')}</th>
                <th className="font-normal px-2 py-1 w-[28%]">{t('devtools.network.waterfall')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr
                  key={r.requestId}
                  onClick={() => setSelectedId(r.requestId)}
                  // content-visibility lets the engine skip layout/paint for rows
                  // scrolled out of view — keeps a 1,500-row log smooth without a
                  // virtualization library. The intrinsic-size hint reserves the
                  // row's height so the scrollbar doesn't jump.
                  style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 22px' }}
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
                  <td className="px-1 py-0.5 text-fg-tertiary tabular-nums">
                    {r.method ?? '—'}
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
                  <td className="px-2 py-0.5">
                    <Waterfall entry={r} wf={wf} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {requests.length > 0 ? <SummaryBar summary={summary} /> : null}

      {selected ? (
        <div className="flex-[2] min-h-0 border-t border-subtle">
          <Detail entry={selected} onClose={() => setSelectedId(null)} />
        </div>
      ) : null}
    </div>
  );
}

/** A single request's position on the shared waterfall timeline. */
