import { useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useI18n } from '../../../i18n/useI18n';
import { cn } from '../../../lib/cn';
import { toast } from '../../../lib/toast';
import { toMessage } from '../../../lib/toMessage';
import { askAgent } from '../../agent/store';
import { useDevtoolsStore } from '../store';
import type { NetworkEntry } from '../types';
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

function Initiator({ initiator }: { initiator: NetworkEntry['initiator'] }) {
  const { t } = useI18n();
  if (!initiator) {
    return <div className="text-caption text-fg-tertiary px-2">{t('agent.chat.unknown')}</div>;
  }
  const top = initiator.stack?.callFrames?.[0];
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

export function Detail({ entry, onClose }: { entry: NetworkEntry; onClose: () => void }) {
  const { t } = useI18n();
  // The agent chat lives in the main window; hide the hand-off in the popout.
  const windowMode = useDevtoolsStore((s) => s.windowMode);
  const [body, setBody] = useState<string | null>(null);
  const [bodyState, setBodyState] = useState<'idle' | 'loading' | 'empty'>('idle');
  const [bodyQuery, setBodyQuery] = useState('');
  // Reset the loaded body when the selected request changes, using the
  // store-previous-prop pattern (no effect → no cascading render), matching
  // SettingsView's TextField.
  const [reqId, setReqId] = useState(entry.requestId);
  if (reqId !== entry.requestId) {
    setReqId(entry.requestId);
    setBody(null);
    setBodyState('idle');
    setBodyQuery('');
  }

  // The displayed body: JSON pretty-printed when applicable. `null` until loaded.
  const shownBody = body === null ? null : prettyBody(body, entry.mimeType);
  const requestPayload =
    entry.requestPostData === undefined
      ? null
      : prettyBody(entry.requestPostData, headerValue(entry.requestHeaders, 'content-type'));
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
      <div className="flex-1 min-h-0 overflow-auto py-2 flex flex-col gap-3">
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
        <Section title={t('devtools.network.timing')}>
          <TimingBars entry={entry} />
        </Section>
        <Section title={t('devtools.network.initiator')}>
          <Initiator initiator={entry.initiator} />
        </Section>
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
              </div>
              <pre className="font-mono text-caption text-fg-secondary px-2 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                {highlight(shownBody, bodyQuery)}
              </pre>
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
