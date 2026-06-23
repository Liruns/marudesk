import { useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useI18n } from '../../../i18n/useI18n';
import { cn } from '../../../lib/cn';
import { toast } from '../../../lib/toast';
import { toMessage } from '../../../lib/toMessage';
import { askAgent } from '../../agent/store';
import { useDevtoolsStore } from '../store';
import { buildFetchSnippet } from '../har';
import type { NetworkEntry, SseMessage, WsFrame } from '../types';
import { parseFormBody, parseQueryParams } from '../network/detail';
import { parseJsonContainer } from '../json-value';
import { JsonTree } from '../components/JsonTree';
import {
  buildCurl,
  buildNetworkFixPrompt,
  fileName,
  fmtBytes,
  fmtMs,
  headerValue,
  isFailure,
  prettyBody,
  statusClass,
  summarize,
} from './network-utils';
import { parseCookieHeader, parseSetCookieHeader } from './network-cookies';

function highlight(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const out: React.ReactNode[] = [];
  let from = 0;
  let at = lower.indexOf(needle, from);
  let key = 0;
  while (at !== -1) {
    if (at > from) out.push(text.slice(from, at));
    out.push(
      <mark key={key++} className="bg-accent/30 text-fg-primary rounded-sm">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
    at = lower.indexOf(needle, from);
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

function HeaderList({ headers }: { headers?: Record<string, string> }) {
  const { t } = useI18n();
  if (!headers || Object.keys(headers).length === 0) {
    return <div className="text-caption text-fg-tertiary px-2">{t('devtools.network.none')}</div>;
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

/** Two-column key/value table (query params, form data). */
function KvTable({ rows }: { rows: [string, string][] }) {
  return (
    <table className="w-full text-caption">
      <tbody>
        {rows.map(([k, v], i) => (
          <tr key={`${k}-${i}`} className="align-top hover:bg-surface-2">
            <td className="px-2 py-0.5 font-mono text-fg-primary break-all w-1/3">{k}</td>
            <td className="px-2 py-0.5 font-mono text-fg-secondary break-all">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A compact timing breakdown: the major phases as labelled bars. */
function TimingBars({ entry }: { entry: NetworkEntry }) {
  const { t } = useI18n();
  const timing = entry.timing;
  if (!timing) {
    // No CDP timing (cache hit / failed early) — fall back to the total wall time.
    if (entry.endTime === undefined) {
      return <div className="text-caption text-fg-tertiary px-2">{t('devtools.network.noTimingData')}</div>;
    }
    const total = (entry.endTime - entry.startTime) * 1000;
    return (
      <div className="font-mono text-caption px-2 text-fg-secondary">
        {t('devtools.network.total')}: {total.toFixed(1)} ms
      </div>
    );
  }
  // Phase windows as [label, startMs, endMs] relative to requestTime; skip
  // phases that didn't occur (CDP marks them -1) or are zero-width.
  const allPhases: [string, number, number][] = [
    ['DNS', timing.dnsStart, timing.dnsEnd],
    ['Connect', timing.connectStart, timing.connectEnd],
    ['SSL', timing.sslStart, timing.sslEnd],
    ['Send', timing.sendStart, timing.sendEnd],
    ['Wait (TTFB)', timing.sendEnd, timing.receiveHeadersEnd],
  ];
  const phases = allPhases.filter(([, s, e]) => s >= 0 && e >= 0 && e > s);
  // Total end: prefer the response receiveHeadersEnd extended to loadingFinished.
  const endMs =
    entry.endTime !== undefined
      ? (entry.endTime - timing.requestTime) * 1000
      : timing.receiveHeadersEnd;
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
        {t('devtools.network.total')}: {endMs.toFixed(1)} ms
      </div>
    </div>
  );
}

// Initiator stack frames are bounded for rendering (deep async stacks).
const MAX_STACK_FRAMES = 50;

function Initiator({ initiator }: { initiator: NetworkEntry['initiator'] }) {
  const { t } = useI18n();
  if (!initiator) {
    return <div className="text-caption text-fg-tertiary px-2">{t('agent.chat.unknown')}</div>;
  }
  const frames = initiator.stack?.callFrames ?? [];
  const shown = frames.slice(0, MAX_STACK_FRAMES);
  return (
    <div className="font-mono text-caption px-2 flex flex-col gap-0.5 break-words">
      <div>
        <span className="text-fg-tertiary">{t('devtools.network.type')}: </span>
        <span className="text-fg-secondary">{initiator.type}</span>
      </div>
      {initiator.url ? (
        <div>
          <span className="text-fg-tertiary">{t('devtools.network.url')}: </span>
          <span className="text-fg-secondary">
            {initiator.url}
            {initiator.lineNumber !== undefined ? `:${initiator.lineNumber + 1}` : ''}
          </span>
        </div>
      ) : null}
      {shown.length > 0 ? (
        <div className="flex flex-col gap-0.5 pt-1">
          <span className="text-fg-tertiary">{t('devtools.network.stackTrace')}</span>
          {shown.map((f, i) => (
            <div key={i} className="pl-2 break-all">
              <span className="text-fg-secondary">{f.functionName || '(anonymous)'}</span>
              <span className="text-fg-tertiary">
                {' @ '}
                {f.url}:{f.lineNumber + 1}:{f.columnNumber + 1}
              </span>
            </div>
          ))}
          {frames.length > shown.length ? (
            <span className="pl-2 text-fg-tertiary">
              +{frames.length - shown.length} more frames
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ── Cookies tab (parsed request Cookie + response Set-Cookie headers) ── */

function CookiesTab({ entry }: { entry: NetworkEntry }) {
  const { t } = useI18n();
  const request = parseCookieHeader(headerValue(entry.requestHeaders, 'cookie'));
  const response = parseSetCookieHeader(headerValue(entry.responseHeaders, 'set-cookie'));
  if (request.length === 0 && response.length === 0) {
    return (
      <div className="text-caption text-fg-tertiary px-2">
        {t('devtools.application.noCookies')}
      </div>
    );
  }
  const th = 'font-normal px-2 py-0.5 text-left';
  return (
    <>
      {request.length > 0 ? (
        <Section title={t('devtools.network.requestCookies')}>
          <table className="w-full text-caption">
            <thead className="text-fg-tertiary">
              <tr>
                <th className={cn(th, 'w-1/3')}>{t('devtools.application.name')}</th>
                <th className={th}>{t('devtools.application.value')}</th>
              </tr>
            </thead>
            <tbody>
              {request.map((c, i) => (
                <tr key={i} className="align-top hover:bg-surface-2">
                  <td className="px-2 py-0.5 font-mono text-fg-primary break-all">{c.name}</td>
                  <td className="px-2 py-0.5 font-mono text-fg-secondary break-all">{c.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : null}
      {response.length > 0 ? (
        <Section title={t('devtools.network.responseCookies')}>
          <table className="w-full text-caption">
            <thead className="text-fg-tertiary">
              <tr>
                <th className={cn(th, 'w-1/4')}>{t('devtools.application.name')}</th>
                <th className={th}>{t('devtools.application.value')}</th>
                <th className={th}>{t('devtools.network.attributes')}</th>
              </tr>
            </thead>
            <tbody>
              {response.map((c, i) => (
                <tr key={i} className="align-top hover:bg-surface-2">
                  <td className="px-2 py-0.5 font-mono text-fg-primary break-all">{c.name}</td>
                  <td className="px-2 py-0.5 font-mono text-fg-secondary break-all">{c.value}</td>
                  <td className="px-2 py-0.5 font-mono text-fg-tertiary break-all">
                    {c.attributes
                      .map((a) => (a.value !== undefined ? `${a.name}=${a.value}` : a.name))
                      .join('; ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : null}
    </>
  );
}

/* ── Messages tab (WebSocket frames + SSE messages) ─────────────────────── */

const OPCODE_NOTE: Record<number, string> = {
  0: '(continuation)',
  8: '(close)',
  9: '(ping)',
  10: '(pong)',
};

/**
 * Frame/message time as a wall clock (`HH:MM:SS.mmm`), derived from the row's
 * wallTime anchor + the frame's monotonic offset. Falls back to a relative
 * `+s` offset when the row never saw a handshake wallTime.
 */
function frameClock(entry: NetworkEntry, timestamp: number): string {
  const offsetMs = (timestamp - entry.startTime) * 1000;
  if (entry.wallTime !== undefined) {
    const d = new Date(entry.wallTime + offsetMs);
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }
  return `+${Math.max(0, offsetMs / 1000).toFixed(3)} s`;
}

function WsFrameRow({ entry, frame }: { entry: NetworkEntry; frame: WsFrame }) {
  const arrow =
    frame.direction === 'sent' ? '↑' : frame.direction === 'received' ? '↓' : '✕';
  const arrowClass =
    frame.direction === 'sent'
      ? 'text-fg-secondary'
      : frame.direction === 'received'
        ? 'text-accent'
        : 'text-error';
  let payload: React.ReactNode;
  if (frame.direction === 'error') {
    payload = <span className="text-error">{frame.payloadData}</span>;
  } else if (frame.opcode === 2) {
    payload = (
      <span className="text-fg-tertiary">
        (binary frame, {frame.payloadBytes ?? 0} bytes)
      </span>
    );
  } else if (frame.opcode === 1) {
    payload = (
      <span className="text-fg-secondary">
        {frame.payloadData}
        {frame.payloadTruncated ? '…' : ''}
      </span>
    );
  } else {
    payload = (
      <span className="text-fg-tertiary">
        {OPCODE_NOTE[frame.opcode] ?? `(opcode ${frame.opcode})`}
        {frame.payloadData ? ` ${frame.payloadData}` : ''}
      </span>
    );
  }
  return (
    <div className="flex items-start gap-2 px-2 py-0.5 border-b border-subtle/40 font-mono text-caption">
      <span className={cn('shrink-0 w-3 text-center select-none', arrowClass)} aria-hidden>
        {arrow}
      </span>
      <span className="flex-1 min-w-0 whitespace-pre-wrap break-all">{payload}</span>
      <span className="shrink-0 tabular-nums text-fg-tertiary">
        {frameClock(entry, frame.timestamp)}
      </span>
    </div>
  );
}

function SseRow({ entry, message }: { entry: NetworkEntry; message: SseMessage }) {
  return (
    <div className="flex items-start gap-2 px-2 py-0.5 border-b border-subtle/40 font-mono text-caption">
      <span className="shrink-0 w-3 text-center text-accent select-none" aria-hidden>
        ↓
      </span>
      <span className="shrink-0 text-fg-primary">{message.eventName}</span>
      <span className="flex-1 min-w-0 whitespace-pre-wrap break-all text-fg-secondary">
        {message.data}
        {message.dataTruncated ? '…' : ''}
      </span>
      {message.eventId ? (
        <span className="shrink-0 text-fg-tertiary">id: {message.eventId}</span>
      ) : null}
      <span className="shrink-0 tabular-nums text-fg-tertiary">
        {frameClock(entry, message.timestamp)}
      </span>
    </div>
  );
}

function MessagesTab({ entry }: { entry: NetworkEntry }) {
  const frames = entry.frames ?? [];
  const sse = entry.sseMessages ?? [];
  const dropped = (entry.framesDropped ?? 0) + (entry.sseDropped ?? 0);
  if (frames.length === 0 && sse.length === 0) {
    return <div className="text-caption text-fg-tertiary px-2">No messages yet</div>;
  }
  return (
    <div className="flex flex-col">
      {dropped > 0 ? (
        <div className="px-2 pb-1 text-caption text-fg-tertiary">
          {dropped} dropped (oldest messages past the cap)
        </div>
      ) : null}
      {frames.map((f, i) => (
        <WsFrameRow key={i} entry={entry} frame={f} />
      ))}
      {sse.map((m, i) => (
        <SseRow key={i} entry={entry} message={m} />
      ))}
    </div>
  );
}

/** The detail pane's tab strip (Chrome's Headers/Response/Timing/… tabs). */
type DetailTab = 'headers' | 'messages' | 'response' | 'timing' | 'initiator' | 'cookies';

export function Detail({ entry, onClose }: { entry: NetworkEntry; onClose: () => void }) {
  const { t } = useI18n();
  // The agent chat lives in the main window; hide the hand-off in the popout.
  const windowMode = useDevtoolsStore((s) => s.windowMode);
  const [body, setBody] = useState<string | null>(null);
  const [bodyState, setBodyState] = useState<'idle' | 'loading' | 'empty'>('idle');
  const [bodyQuery, setBodyQuery] = useState('');
  const [tab, setTab] = useState<DetailTab>('headers');
  // Response body view: raw (pretty text + search) or a collapsible JSON tree.
  const [bodyView, setBodyView] = useState<'raw' | 'tree'>('raw');
  // Reset the loaded body when the selected request changes, using the
  // store-previous-prop pattern (no effect → no cascading render), matching
  // SettingsView's TextField.
  const [reqId, setReqId] = useState(entry.requestId);
  if (reqId !== entry.requestId) {
    setReqId(entry.requestId);
    setBody(null);
    setBodyState('idle');
    setBodyQuery('');
    setTab('headers');
    setBodyView('raw');
  }

  // Messages only exists for WebSocket connections and SSE streams.
  const hasMessages = !!entry.isWebSocket || (entry.sseMessages?.length ?? 0) > 0;
  const tabs: { id: DetailTab; label: string }[] = [
    { id: 'headers', label: t('devtools.network.tab.headers') },
    ...(hasMessages ? [{ id: 'messages' as const, label: t('devtools.network.tab.messages') }] : []),
    { id: 'response', label: t('devtools.network.tab.response') },
    { id: 'timing', label: t('devtools.network.tab.timing') },
    { id: 'initiator', label: t('devtools.network.initiator') },
    { id: 'cookies', label: t('devtools.network.tab.cookies') },
  ];
  const active: DetailTab = tab === 'messages' && !hasMessages ? 'headers' : tab;

  // The displayed body: JSON pretty-printed when applicable. `null` until loaded.
  const shownBody = body === null ? null : prettyBody(body, entry.mimeType);
  // JSON container for the tree view, or undefined (toggle hidden).
  const bodyTree = body === null ? undefined : parseJsonContainer(body);
  const queryParams = parseQueryParams(entry.url);
  const requestContentType = headerValue(entry.requestHeaders, 'content-type');
  // Form-encoded bodies render as a key/value table; others pretty-print.
  const formRows =
    entry.requestPostData === undefined
      ? null
      : parseFormBody(entry.requestPostData, requestContentType);
  const requestPayload =
    entry.requestPostData === undefined || formRows
      ? null
      : prettyBody(entry.requestPostData, requestContentType);
  const bodyMatches =
    shownBody && bodyQuery
      ? shownBody.toLowerCase().split(bodyQuery.toLowerCase()).length - 1
      : 0;

  const loadBody = async () => {
    setBodyState('loading');
    const res = await useDevtoolsStore.getState().getResponseBody(entry.requestId);
    if (!res) {
      setBodyState('empty');
      return;
    }
    setBody(res.base64Encoded ? t('devtools.network.binaryNotShown') : res.body);
    setBodyState('idle');
  };

  const copyCurl = async () => {
    try {
      await navigator.clipboard.writeText(buildCurl(entry));
      toast({ title: t('devtools.network.copiedCurl'), variant: 'success' });
    } catch (err) {
      toast({ title: t('common.copyFailed'), description: toMessage(err), variant: 'error' });
    }
  };

  const copyFetch = async () => {
    try {
      await navigator.clipboard.writeText(buildFetchSnippet(entry));
      toast({ title: t('devtools.network.copiedAsFetch'), variant: 'success' });
    } catch (err) {
      toast({ title: t('common.copyFailed'), description: toMessage(err), variant: 'error' });
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
              title={t('devtools.network.askFixTitle')}
              className="h-5 px-1.5 rounded inline-flex items-center gap-1 text-caption text-accent hover:bg-accent-subtle/40 transition-colors duration-fast"
            >
              <Sparkles size={11} />
              {t('devtools.network.fixThis')}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void copyCurl()}
            title={t('devtools.network.copyCurl')}
            className="h-5 px-1.5 rounded text-caption text-fg-tertiary hover:text-fg-primary hover:bg-surface-2"
          >
            {t('devtools.network.copyCurl')}
          </button>
          <button
            type="button"
            onClick={() => void copyFetch()}
            title={t('devtools.network.copyAsFetch')}
            className="h-5 px-1.5 rounded text-caption text-fg-tertiary hover:text-fg-primary hover:bg-surface-2"
          >
            {t('devtools.network.copyAsFetch')}
          </button>
          <button
            type="button"
            aria-label={t('devtools.network.closeDetail')}
            onClick={onClose}
            className="size-5 rounded flex items-center justify-center text-fg-tertiary hover:text-fg-primary"
          >
            <X size={13} />
          </button>
        </div>
      </div>
      <div className="shrink-0 flex items-center gap-0.5 px-1.5 py-1 border-b border-subtle overflow-x-auto">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            type="button"
            aria-pressed={active === tb.id}
            onClick={() => setTab(tb.id)}
            className={cn(
              'h-6 px-1.5 rounded text-caption transition-colors duration-fast whitespace-nowrap',
              active === tb.id
                ? 'bg-surface-page text-fg-primary'
                : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-2',
            )}
          >
            {tb.label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-auto py-2 flex flex-col gap-3">
        {active === 'headers' ? (
          <>
            <Section title={t('devtools.network.general')}>
              <div className="font-mono text-caption px-2 flex flex-col gap-0.5 break-words">
                <div>
                  <span className="text-fg-tertiary">{t('devtools.network.requestUrl')}: </span>
                  <span className="text-fg-secondary">{entry.url}</span>
                </div>
                <div>
                  <span className="text-fg-tertiary">{t('devtools.network.method')}: </span>
                  <span className="text-fg-secondary">{entry.method}</span>
                </div>
                <div>
                  <span className="text-fg-tertiary">{t('devtools.network.status')}: </span>
                  <span className={statusClass(entry)}>
                    {entry.failed
                      ? `(failed) ${entry.errorText ?? ''}`
                      : `${entry.status ?? '—'} ${entry.statusText ?? ''}`}
                  </span>
                </div>
                {entry.remoteIPAddress ? (
                  <div>
                    <span className="text-fg-tertiary">{t('devtools.network.remoteAddress')}: </span>
                    <span className="text-fg-secondary">{entry.remoteIPAddress}</span>
                  </div>
                ) : null}
              </div>
            </Section>
            <Section title={t('devtools.network.responseHeaders')}>
              <HeaderList headers={entry.responseHeaders} />
            </Section>
            <Section title={t('devtools.network.requestHeaders')}>
              <HeaderList headers={entry.requestHeaders} />
            </Section>
            {queryParams.length > 0 ? (
              <Section title={t('devtools.network.queryParams')}>
                <KvTable rows={queryParams} />
              </Section>
            ) : null}
            {formRows && formRows.length > 0 ? (
              <Section title={t('devtools.network.formData')}>
                <KvTable rows={formRows} />
              </Section>
            ) : null}
            {requestPayload !== null ? (
              <Section title={t('devtools.network.requestPayload')}>
                <pre className="font-mono text-caption text-fg-secondary px-2 whitespace-pre-wrap break-words max-h-48 overflow-auto">
                  {requestPayload}
                </pre>
                {entry.requestPostDataTruncated ? (
                  <div className="text-caption text-fg-tertiary px-2">
                    {t('devtools.network.requestPayloadClipped')}
                  </div>
                ) : null}
              </Section>
            ) : null}
          </>
        ) : active === 'messages' ? (
          <MessagesTab entry={entry} />
        ) : active === 'timing' ? (
          <Section title={t('devtools.network.timing')}>
            <TimingBars entry={entry} />
          </Section>
        ) : active === 'initiator' ? (
          <Section title={t('devtools.network.initiator')}>
            <Initiator initiator={entry.initiator} />
          </Section>
        ) : active === 'cookies' ? (
          <CookiesTab entry={entry} />
        ) : (
          <Section title={t('devtools.network.response')}>
            {bodyState === 'empty' ? (
              <div className="text-caption text-fg-tertiary px-2">
                {t('devtools.network.noBody')}
              </div>
            ) : shownBody !== null ? (
              <div className="flex flex-col gap-1 min-h-0">
                <div className="flex items-center gap-2 px-2">
                  <input
                    value={bodyQuery}
                    onChange={(e) => setBodyQuery(e.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={t('devtools.network.searchResponse')}
                    aria-label={t('devtools.network.searchResponseBody')}
                    className="h-6 flex-1 min-w-0 rounded bg-surface-2 px-2 text-caption text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:ring-1 focus:ring-accent/50"
                  />
                  {bodyQuery ? (
                    <span className="text-caption tabular-nums text-fg-tertiary shrink-0">
                      {bodyMatches} {bodyMatches === 1 ? t('devtools.network.match') : t('devtools.network.matches')}
                    </span>
                  ) : null}
                  {bodyTree !== undefined ? (
                    <div className="flex items-center gap-0.5 shrink-0">
                      {(['raw', 'tree'] as const).map((v) => (
                        <button
                          key={v}
                          type="button"
                          aria-pressed={bodyView === v}
                          onClick={() => setBodyView(v)}
                          className={cn(
                            'h-5 px-1.5 rounded text-caption transition-colors duration-fast',
                            bodyView === v
                              ? 'bg-surface-page text-fg-primary'
                              : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-2',
                          )}
                        >
                          {v === 'raw' ? t('devtools.network.viewRaw') : t('devtools.network.viewTree')}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                {bodyView === 'tree' && bodyTree !== undefined ? (
                  <div className="px-2 max-h-64 overflow-auto">
                    <JsonTree value={bodyTree} />
                  </div>
                ) : (
                  <pre className="font-mono text-caption text-fg-secondary px-2 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                    {highlight(shownBody, bodyQuery)}
                  </pre>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => void loadBody()}
                disabled={bodyState === 'loading'}
                className="mx-2 h-6 px-2 rounded bg-surface-2 text-caption text-fg-secondary hover:text-fg-primary disabled:opacity-50"
              >
                {bodyState === 'loading' ? t('devtools.network.loading') : t('devtools.network.loadResponseBody')}
              </button>
            )}
          </Section>
        )}
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


export function Waterfall({
  entry,
  wf,
}: {
  entry: NetworkEntry;
  wf: { min: number; span: number } | null;
}) {
  if (!wf) return null;
  const start = entry.startTime;
  const end = entry.endTime ?? start;
  const left = ((start - wf.min) / wf.span) * 100;
  const width = Math.max(((end - start) / wf.span) * 100, 0.5);
  return (
    <div className="relative h-2 w-full" aria-hidden>
      <div
        className={cn(
          'absolute top-0 h-full rounded-sm',
          entry.failed ? 'bg-error/60' : entry.endTime === undefined ? 'bg-accent/40' : 'bg-accent/60',
        )}
        style={{ left: `${Math.min(left, 100)}%`, width: `${Math.min(width, 100)}%` }}
      />
    </div>
  );
}

/** The bottom status bar: request count, transferred bytes, and page timing. */
export function SummaryBar({
  summary,
}: {
  summary: ReturnType<typeof summarize>;
}) {
  const { t } = useI18n();
  return (
    <div className="shrink-0 h-6 flex items-center gap-3 px-2 border-t border-subtle text-caption text-fg-tertiary tabular-nums whitespace-nowrap overflow-hidden">
      <span>
        <span className="text-fg-secondary">{summary.count}</span> {t('devtools.network.requests')}
      </span>
      <span>
        <span className="text-fg-secondary">{fmtBytes(summary.transferred)}</span> {t('devtools.network.transferred')}
      </span>
      {summary.finish !== null ? (
        <span>
          {t('devtools.network.finish')} <span className="text-fg-secondary">{fmtMs(summary.finish)}</span>
        </span>
      ) : null}
      {summary.dcl !== null ? (
        <span>
          DOMContentLoaded <span className="text-fg-secondary">{fmtMs(summary.dcl)}</span>
        </span>
      ) : null}
      {summary.loaded !== null ? (
        <span>
          {t('devtools.network.load')} <span className="text-fg-secondary">{fmtMs(summary.loaded)}</span>
        </span>
      ) : null}
    </div>
  );
}
