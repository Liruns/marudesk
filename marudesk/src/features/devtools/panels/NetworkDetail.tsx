import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronRight, Sparkles, X } from 'lucide-react';
import { useI18n } from '../../../i18n/useI18n';
import type { TranslationKey } from '../../../i18n/messages';
import { cn } from '../../../lib/cn';
import { toast } from '../../../lib/toast';
import { toMessage } from '../../../lib/toMessage';
import { askAgent } from '../../agent/store';
import { useDevtoolsStore } from '../store';
import type { NetworkEntry } from '../types';
import {
  frameClock,
  parseFormBody,
  parseQueryParams,
  timingPhases,
  type TimingPhaseKey,
} from '../network/detail';
import { frameKindLabel, isStreamEntry, type WsFrame } from '../ws-frames';
import { parseJsonContainer } from '../json-value';
import { JsonTree } from '../components/JsonTree';
import {
  buildCurl,
  buildNetworkFixPrompt,
  fileName,
  headerValue,
  isFailure,
  prettyBody,
  statusClass,
} from './network-utils';

/**
 * The Network panel's request detail pane, as proper DevTools-style tabs:
 * Headers (collapsible general/response/request sections, copy-on-click values),
 * Payload (parsed query string + form/JSON body), Response (on-demand body with
 * pretty JSON, tree view, search, copy), Timing (classic phase bars from the
 * CDP resource timing), Initiator, and — for WebSocket/SSE rows — Frames (the
 * per-connection ring buffer with direction/opcode/payload/time).
 */

type DetailTab = 'headers' | 'frames' | 'payload' | 'response' | 'timing' | 'initiator';

const TAB_LABELS: Record<DetailTab, TranslationKey> = {
  headers: 'devtools.network.tab.headers',
  frames: 'devtools.network.tab.frames',
  payload: 'devtools.network.tab.payload',
  response: 'devtools.network.tab.response',
  timing: 'devtools.network.tab.timing',
  initiator: 'devtools.network.tab.initiator',
};

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

/** A monospace value that copies itself on click (Headers/Payload tabs). */
function CopyValue({ text, className }: { text: string; className?: string }) {
  const { t } = useI18n();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: t('devtools.network.copiedValue'), variant: 'success' });
    } catch (err) {
      toast({ title: t('common.copyFailed'), description: toMessage(err), variant: 'error' });
    }
  };
  return (
    <span
      role="button"
      tabIndex={0}
      title={t('devtools.network.clickToCopy')}
      onClick={() => void copy()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void copy();
      }}
      className={cn(
        'cursor-pointer hover:underline decoration-dotted underline-offset-2',
        className ?? 'text-fg-secondary',
      )}
    >
      {text}
    </span>
  );
}

/** A collapsible titled section (Headers tab). */
function Collapsible({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 px-1 h-6 text-caption uppercase tracking-wide text-fg-tertiary hover:text-fg-secondary w-full text-left"
      >
        <ChevronRight
          size={12}
          className={cn('transition-transform shrink-0', open && 'rotate-90')}
        />
        {title}
      </button>
      {open ? <div className="flex flex-col gap-0.5 pb-1">{children}</div> : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-caption uppercase tracking-wide text-fg-tertiary px-2">{title}</div>
      {children}
    </div>
  );
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
          <CopyValue text={v} />
        </div>
      ))}
    </div>
  );
}

function HeadersTab({ entry }: { entry: NetworkEntry }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1 px-1">
      <Collapsible title={t('devtools.network.general')}>
        <div className="font-mono text-caption px-2 flex flex-col gap-0.5 break-words">
          <div>
            <span className="text-fg-tertiary">{t('devtools.network.requestUrl')}: </span>
            <CopyValue text={entry.url} />
          </div>
          <div>
            <span className="text-fg-tertiary">{t('devtools.network.method')}: </span>
            <CopyValue text={entry.method} />
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
              <CopyValue text={entry.remoteIPAddress} />
            </div>
          ) : null}
        </div>
      </Collapsible>
      <Collapsible title={t('devtools.network.responseHeaders')}>
        <HeaderList headers={entry.responseHeaders} />
      </Collapsible>
      <Collapsible title={t('devtools.network.requestHeaders')}>
        <HeaderList headers={entry.requestHeaders} />
      </Collapsible>
    </div>
  );
}

/** Two-column key/value table (query params, form data) with copyable values. */
function KvTable({ rows }: { rows: [string, string][] }) {
  return (
    <table className="w-full text-caption">
      <tbody>
        {rows.map(([k, v], i) => (
          <tr key={`${k}-${i}`} className="align-top hover:bg-surface-2">
            <td className="px-2 py-0.5 font-mono text-fg-primary break-all w-1/3">{k}</td>
            <td className="px-2 py-0.5 font-mono break-all">
              <CopyValue text={v} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PayloadTab({ entry }: { entry: NetworkEntry }) {
  const { t } = useI18n();
  const queryParams = useMemo(() => parseQueryParams(entry.url), [entry.url]);
  const contentType = headerValue(entry.requestHeaders, 'content-type');
  const formRows =
    entry.requestPostData !== undefined
      ? parseFormBody(entry.requestPostData, contentType)
      : null;
  const prettyPayload =
    entry.requestPostData !== undefined && !formRows
      ? prettyBody(entry.requestPostData, contentType)
      : null;
  if (queryParams.length === 0 && entry.requestPostData === undefined) {
    return (
      <div className="text-caption text-fg-tertiary px-2 py-2">
        {t('devtools.network.noPayload')}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 py-1">
      {queryParams.length > 0 ? (
        <Section title={t('devtools.network.queryParams')}>
          <KvTable rows={queryParams} />
        </Section>
      ) : null}
      {formRows ? (
        <Section title={t('devtools.network.formData')}>
          <KvTable rows={formRows} />
        </Section>
      ) : null}
      {prettyPayload !== null ? (
        <Section title={t('devtools.network.requestPayload')}>
          <pre className="font-mono text-caption text-fg-secondary px-2 whitespace-pre-wrap break-words max-h-64 overflow-auto">
            {prettyPayload}
          </pre>
        </Section>
      ) : null}
      {entry.requestPostDataTruncated ? (
        <div className="text-caption text-fg-tertiary px-2">
          {t('devtools.network.requestPayloadClipped')}
        </div>
      ) : null}
    </div>
  );
}

function ResponseTab({
  entry,
  body,
  bodyState,
  bodyQuery,
  setBodyQuery,
  loadBody,
}: {
  entry: NetworkEntry;
  body: string | null;
  bodyState: 'idle' | 'loading' | 'empty';
  bodyQuery: string;
  setBodyQuery: (q: string) => void;
  loadBody: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<'raw' | 'tree'>('raw');
  const shownBody = body === null ? null : prettyBody(body, entry.mimeType);
  const treeValue = useMemo(
    () => (body === null ? undefined : parseJsonContainer(body)),
    [body],
  );
  const bodyMatches =
    shownBody && bodyQuery
      ? shownBody.toLowerCase().split(bodyQuery.toLowerCase()).length - 1
      : 0;

  const copyBody = async () => {
    if (shownBody === null) return;
    try {
      await navigator.clipboard.writeText(shownBody);
      toast({ title: t('devtools.network.copiedBody'), variant: 'success' });
    } catch (err) {
      toast({ title: t('common.copyFailed'), description: toMessage(err), variant: 'error' });
    }
  };

  if (bodyState === 'empty') {
    return (
      <div className="text-caption text-fg-tertiary px-2 py-2">{t('devtools.network.noBody')}</div>
    );
  }
  if (shownBody === null) {
    return (
      <div className="px-2 py-2">
        <button
          type="button"
          onClick={() => void loadBody()}
          disabled={bodyState === 'loading'}
          className="h-6 px-2 rounded bg-surface-2 text-caption text-fg-secondary hover:text-fg-primary disabled:opacity-50"
        >
          {bodyState === 'loading'
            ? t('devtools.network.loading')
            : t('devtools.network.loadResponseBody')}
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 min-h-0 py-1">
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
            {bodyMatches}{' '}
            {bodyMatches === 1 ? t('devtools.network.match') : t('devtools.network.matches')}
          </span>
        ) : null}
        {treeValue !== undefined ? (
          <div className="flex items-center gap-0.5 shrink-0">
            {(['raw', 'tree'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className={cn(
                  'h-5 px-1.5 rounded text-caption transition-colors duration-fast',
                  view === v
                    ? 'bg-surface-page text-fg-primary'
                    : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-2',
                )}
              >
                {v === 'raw' ? t('devtools.network.viewRaw') : t('devtools.network.viewTree')}
              </button>
            ))}
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => void copyBody()}
          className="h-5 px-1.5 rounded text-caption text-fg-tertiary hover:text-fg-primary hover:bg-surface-2 shrink-0"
        >
          {t('devtools.network.copyBody')}
        </button>
      </div>
      {view === 'tree' && treeValue !== undefined ? (
        <div className="px-2 max-h-64 overflow-auto">
          <JsonTree value={treeValue} />
        </div>
      ) : (
        <pre className="font-mono text-caption text-fg-secondary px-2 whitespace-pre-wrap break-words max-h-64 overflow-auto">
          {highlight(shownBody, bodyQuery)}
        </pre>
      )}
    </div>
  );
}

const PHASE_LABELS: Record<TimingPhaseKey, TranslationKey> = {
  blocked: 'devtools.network.phase.blocked',
  dns: 'devtools.network.phase.dns',
  connect: 'devtools.network.phase.connect',
  tls: 'devtools.network.phase.tls',
  send: 'devtools.network.phase.send',
  wait: 'devtools.network.phase.wait',
  receive: 'devtools.network.phase.receive',
};

// Bar fills per phase — an accent alpha ramp (tokens only; the label carries
// the semantics, the ramp just separates adjacent bars).
const PHASE_BARS: Record<TimingPhaseKey, string> = {
  blocked: 'bg-fg-tertiary/40',
  dns: 'bg-accent/30',
  connect: 'bg-accent/40',
  tls: 'bg-accent/50',
  send: 'bg-accent/60',
  wait: 'bg-accent/80',
  receive: 'bg-accent/50',
};

function TimingTab({ entry }: { entry: NetworkEntry }) {
  const { t } = useI18n();
  const breakdown = timingPhases(entry);
  if (!breakdown) {
    // No CDP timing (cache hit / failed early) — fall back to the total wall time.
    if (entry.endTime === undefined) {
      return (
        <div className="text-caption text-fg-tertiary px-2 py-2">
          {t('devtools.network.noTimingData')}
        </div>
      );
    }
    const total = (entry.endTime - entry.startTime) * 1000;
    return (
      <div className="font-mono text-caption px-2 py-2 text-fg-secondary">
        {t('devtools.network.total')}: {total.toFixed(1)} ms
      </div>
    );
  }
  const scale = breakdown.totalMs > 0 ? 100 / breakdown.totalMs : 0;
  return (
    <div className="flex flex-col gap-1 px-2 py-2">
      {breakdown.phases.map((p) => (
        <div key={p.key} className="flex items-center gap-2 text-caption">
          <span className="w-32 shrink-0 text-fg-tertiary">{t(PHASE_LABELS[p.key])}</span>
          <div className="flex-1 h-2.5 bg-surface-2 rounded-sm relative overflow-hidden">
            <div
              className={cn('absolute top-0 h-full rounded-sm', PHASE_BARS[p.key])}
              style={{
                left: `${p.startMs * scale}%`,
                width: `${Math.max(1, (p.endMs - p.startMs) * scale)}%`,
              }}
            />
          </div>
          <span className="w-16 shrink-0 text-right tabular-nums text-fg-secondary">
            {(p.endMs - p.startMs).toFixed(1)} ms
          </span>
        </div>
      ))}
      <div className="font-mono text-caption text-fg-tertiary pt-0.5">
        {t('devtools.network.total')}: {breakdown.totalMs.toFixed(1)} ms
      </div>
    </div>
  );
}

function InitiatorTab({ initiator }: { initiator: NetworkEntry['initiator'] }) {
  const { t } = useI18n();
  if (!initiator) {
    return (
      <div className="text-caption text-fg-tertiary px-2 py-2">{t('agent.chat.unknown')}</div>
    );
  }
  const top = initiator.stack?.callFrames?.[0];
  return (
    <div className="font-mono text-caption px-2 py-2 flex flex-col gap-0.5 break-words">
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
      {top ? (
        <div>
          <span className="text-fg-tertiary">{t('devtools.network.script')}: </span>
          <span className="text-fg-secondary">
            {(top.functionName || '(anonymous)') + ` @ ${top.url}:${top.lineNumber + 1}`}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function FrameRow({ entry, frame }: { entry: NetworkEntry; frame: WsFrame }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const tree = useMemo(
    () => (open ? parseJsonContainer(frame.payload) : undefined),
    [open, frame.payload],
  );
  const sent = frame.direction === 'sent';
  return (
    <div className="border-b border-subtle/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-1.5 px-2 py-0.5 text-left hover:bg-surface-2"
      >
        {sent ? (
          <ArrowUp
            size={12}
            aria-label={t('devtools.network.sent')}
            className="shrink-0 text-accent"
          />
        ) : (
          <ArrowDown
            size={12}
            aria-label={t('devtools.network.received')}
            className="shrink-0 text-success"
          />
        )}
        <span className="shrink-0 w-14 truncate font-mono text-caption text-fg-tertiary">
          {frameKindLabel(frame)}
        </span>
        <span className="flex-1 min-w-0 truncate font-mono text-caption text-fg-secondary">
          {frame.payload}
        </span>
        <span className="shrink-0 tabular-nums text-caption text-fg-tertiary">
          {frame.length}
        </span>
        <span className="shrink-0 tabular-nums text-caption text-fg-tertiary">
          {frameClock(entry, frame.timestamp)}
        </span>
      </button>
      {open ? (
        <div className="px-6 py-1">
          {tree !== undefined ? (
            <JsonTree value={tree} />
          ) : (
            <pre className="font-mono text-caption text-fg-secondary whitespace-pre-wrap break-words max-h-48 overflow-auto">
              {frame.payload}
            </pre>
          )}
          {frame.truncated ? (
            <div className="text-caption text-fg-tertiary pt-0.5">
              {t('devtools.network.frameTruncated')}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function FramesTab({ entry }: { entry: NetworkEntry }) {
  const { t } = useI18n();
  const frames = useDevtoolsStore((s) => s.wsFrames.get(entry.requestId));
  const [filter, setFilter] = useState('');
  const visible = useMemo(() => {
    const all = frames ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (f) =>
        f.payload.toLowerCase().includes(q) ||
        (f.eventName !== undefined && f.eventName.toLowerCase().includes(q)),
    );
  }, [frames, filter]);

  return (
    <div className="flex flex-col min-h-0">
      <div className="shrink-0 px-2 py-1">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          placeholder={t('devtools.network.filterFrames')}
          aria-label={t('devtools.network.filterFramesAria')}
          className="h-6 w-full rounded bg-surface-2 px-2 text-caption text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:ring-1 focus:ring-accent/50"
        />
      </div>
      {!frames || frames.length === 0 ? (
        <div className="text-caption text-fg-tertiary px-2 py-2">
          {t('devtools.network.noFrames')}
        </div>
      ) : visible.length === 0 ? (
        <div className="text-caption text-fg-tertiary px-2 py-2">
          {t('devtools.network.noMatchingFrames')}
        </div>
      ) : (
        <div className="flex flex-col">
          {visible.map((f, i) => (
            <FrameRow key={i} entry={entry} frame={f} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Detail({ entry, onClose }: { entry: NetworkEntry; onClose: () => void }) {
  const { t } = useI18n();
  // The agent chat lives in the main window; hide the hand-off in the popout.
  const windowMode = useDevtoolsStore((s) => s.windowMode);
  const isStream = isStreamEntry(entry.resourceType);
  const isWebSocket = entry.resourceType === 'WebSocket';
  const defaultTab: DetailTab = isStream ? 'frames' : 'headers';
  const [tab, setTab] = useState<DetailTab>(defaultTab);
  const [body, setBody] = useState<string | null>(null);
  const [bodyState, setBodyState] = useState<'idle' | 'loading' | 'empty'>('idle');
  const [bodyQuery, setBodyQuery] = useState('');
  // Reset per-request state when the selected request changes, using the
  // store-previous-prop pattern (no effect → no cascading render).
  const [reqId, setReqId] = useState(entry.requestId);
  if (reqId !== entry.requestId) {
    setReqId(entry.requestId);
    setTab(defaultTab);
    setBody(null);
    setBodyState('idle');
    setBodyQuery('');
  }

  const queryParams = useMemo(() => parseQueryParams(entry.url), [entry.url]);
  const hasPayload = queryParams.length > 0 || entry.requestPostData !== undefined;
  const tabs: DetailTab[] = [
    'headers',
    ...(isStream ? (['frames'] as const) : []),
    ...(hasPayload ? (['payload'] as const) : []),
    // A WS connection has no fetchable response body — its data is the frames.
    ...(!isWebSocket ? (['response'] as const) : []),
    'timing',
    'initiator',
  ];
  const activeTab = tabs.includes(tab) ? tab : 'headers';

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
            aria-label={t('devtools.network.closeDetail')}
            onClick={onClose}
            className="size-5 rounded flex items-center justify-center text-fg-tertiary hover:text-fg-primary"
          >
            <X size={13} />
          </button>
        </div>
      </div>
      <div className="shrink-0 flex items-center gap-0.5 px-1.5 py-0.5 border-b border-subtle overflow-x-auto">
        {tabs.map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={activeTab === id}
            onClick={() => setTab(id)}
            className={cn(
              'h-6 px-2 rounded text-caption whitespace-nowrap transition-colors duration-fast',
              activeTab === id
                ? 'bg-surface-page text-fg-primary'
                : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-2',
            )}
          >
            {t(TAB_LABELS[id])}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-auto py-1">
        {activeTab === 'headers' ? (
          <HeadersTab entry={entry} />
        ) : activeTab === 'frames' ? (
          <FramesTab entry={entry} />
        ) : activeTab === 'payload' ? (
          <PayloadTab entry={entry} />
        ) : activeTab === 'response' ? (
          <ResponseTab
            entry={entry}
            body={body}
            bodyState={bodyState}
            bodyQuery={bodyQuery}
            setBodyQuery={setBodyQuery}
            loadBody={loadBody}
          />
        ) : activeTab === 'timing' ? (
          <TimingTab entry={entry} />
        ) : (
          <InitiatorTab initiator={entry.initiator} />
        )}
      </div>
    </div>
  );
}
