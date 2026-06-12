import { cn } from '../../../lib/cn';
import { useDevtoolsStore } from '../store';
import {
  describeSecurityIssue,
  securityStateLabel,
  type IssueSeverity,
} from '../security-utils';
import type { SecurityState } from '../types';

/**
 * Security panel: a read-only view of the page's visible security state
 * (`Security.visibleSecurityStateChanged`, parsed in security-utils and stored
 * by slice-security). Shows the overall verdict with semantic colors, the
 * certificate/connection details when the page is served over TLS, and the
 * security issue list (mixed content etc.) with severity styling. The snapshot
 * is per-navigation — slice-session resets it so stale certificate info never
 * shows for a new origin. The relay blocks every certificate-error bypass
 * method, so this surface can only ever observe.
 */

type Tone = 'success' | 'error' | 'warning' | 'neutral';

function stateTone(state: SecurityState): Tone {
  if (state === 'secure') return 'success';
  if (state === 'insecure' || state === 'insecure-broken') return 'error';
  if (state === 'neutral') return 'warning';
  return 'neutral';
}

const TONE_TEXT: Record<Tone, string> = {
  success: 'text-success',
  error: 'text-error',
  warning: 'text-warning',
  neutral: 'text-fg-secondary',
};

const TONE_DOT: Record<Tone, string> = {
  success: 'bg-success',
  error: 'bg-error',
  warning: 'bg-warning',
  neutral: 'bg-fg-tertiary',
};

const SEVERITY_DOT: Record<IssueSeverity, string> = {
  error: 'bg-error',
  warning: 'bg-warning',
  info: 'bg-fg-tertiary',
};

/** Seconds since epoch → `YYYY-MM-DD HH:MM:SS`, '—' when absent/invalid. */
function certDate(seconds: number): string {
  if (!seconds) return '—';
  try {
    return new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    return '—';
  }
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="shrink-0 px-2 py-1 text-caption font-medium text-fg-tertiary bg-surface-2/40 border-y border-subtle/40">
      {label}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3 px-3 py-0.5 text-caption">
      <span className="w-28 shrink-0 text-fg-tertiary">{label}</span>
      <span className="font-mono text-fg-primary break-all">{value || '—'}</span>
    </div>
  );
}

export function SecurityPanel() {
  const state = useDevtoolsStore((s) => s.securityState);

  if (!state) {
    return (
      <div className="h-full flex items-center justify-center text-caption text-fg-tertiary px-4 text-center">
        No security state yet. Navigate the page to populate it.
      </div>
    );
  }

  const tone = stateTone(state.securityState);
  const cert = state.certificate;
  const issues = state.issueIds.map(describeSecurityIssue);
  const keyExchange = cert
    ? [cert.keyExchange, cert.keyExchangeGroup].filter(Boolean).join(' ')
    : '';

  return (
    <div className="h-full overflow-auto">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className={cn('size-2 rounded-full shrink-0', TONE_DOT[tone])} />
        <span className={cn('text-body-sm font-medium', TONE_TEXT[tone])}>
          {securityStateLabel(state.securityState)}
        </span>
        <span className="text-caption text-fg-tertiary font-mono">
          {state.securityState}
        </span>
      </div>

      <SectionHeader label="Connection" />
      {cert ? (
        <div className="py-1">
          <DetailRow label="Protocol" value={cert.protocol} />
          <DetailRow label="Key exchange" value={keyExchange} />
          <DetailRow label="Cipher" value={cert.cipher} />
        </div>
      ) : (
        <div className="px-3 py-2 text-caption text-fg-tertiary">
          No TLS connection details. The page was not served over HTTPS.
        </div>
      )}

      <SectionHeader label="Certificate" />
      {cert ? (
        <div className="py-1">
          <DetailRow label="Subject" value={cert.subjectName} />
          <DetailRow label="Issuer" value={cert.issuer} />
          <DetailRow label="Valid from" value={certDate(cert.validFrom)} />
          <DetailRow label="Valid to" value={certDate(cert.validTo)} />
        </div>
      ) : (
        <div className="px-3 py-2 text-caption text-fg-tertiary">No certificate.</div>
      )}

      <SectionHeader label="Issues" />
      {issues.length === 0 ? (
        <div className="px-3 py-2 text-caption text-fg-tertiary">
          No security issues reported.
        </div>
      ) : (
        <div className="py-1">
          {issues.map((issue) => (
            <div key={issue.id} className="flex items-start gap-2 px-3 py-0.5">
              <span
                className={cn(
                  'size-1.5 rounded-full shrink-0 mt-[5px]',
                  SEVERITY_DOT[issue.severity],
                )}
              />
              <span className="text-caption text-fg-secondary">
                {issue.label}
                {issue.label !== issue.id ? (
                  <span className="text-fg-tertiary font-mono"> {issue.id}</span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
