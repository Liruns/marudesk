import type {
  CertificateSecurityState,
  SecurityState,
  VisibleSecurityState,
} from './types';

/**
 * Pure helpers for the Security panel: a typed guard over the raw
 * `Security.visibleSecurityStateChanged` params and the mapping of security
 * state / issue ids to display labels + severity. No CDP and no store access so
 * they stay cheap to unit-test (see security-utils.test.ts).
 */

const SECURITY_STATES: ReadonlySet<SecurityState> = new Set<SecurityState>([
  'unknown',
  'neutral',
  'insecure',
  'secure',
  'info',
  'insecure-broken',
]);

function parseCertificate(value: unknown): CertificateSecurityState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return {
    protocol: str(r.protocol),
    keyExchange: str(r.keyExchange),
    keyExchangeGroup:
      typeof r.keyExchangeGroup === 'string' ? r.keyExchangeGroup : undefined,
    cipher: str(r.cipher),
    subjectName: str(r.subjectName),
    issuer: str(r.issuer),
    validFrom: num(r.validFrom),
    validTo: num(r.validTo),
  };
}

/**
 * Validate the unknown `Security.visibleSecurityStateChanged` params into the
 * normalized snapshot the panel renders. Null when the shape is unusable.
 */
export function parseVisibleSecurityState(params: unknown): VisibleSecurityState | null {
  if (!params || typeof params !== 'object') return null;
  const vss = (params as Record<string, unknown>).visibleSecurityState;
  if (!vss || typeof vss !== 'object') return null;
  const r = vss as Record<string, unknown>;
  const state = r.securityState;
  const securityState: SecurityState =
    typeof state === 'string' && SECURITY_STATES.has(state as SecurityState)
      ? (state as SecurityState)
      : 'unknown';
  const issueIds = Array.isArray(r.securityStateIssueIds)
    ? r.securityStateIssueIds.filter((x): x is string => typeof x === 'string')
    : [];
  return {
    securityState,
    certificate: parseCertificate(r.certificateSecurityState),
    issueIds,
  };
}

/* ── display mapping ──────────────────────────────────────────────────── */

export function securityStateLabel(state: SecurityState): string {
  switch (state) {
    case 'secure':
      return 'Secure';
    case 'insecure':
    case 'insecure-broken':
      return 'Not secure';
    case 'neutral':
      return 'Not secure';
    case 'info':
      return 'Info';
    case 'unknown':
      return 'Unknown';
  }
}

/** Severity drives the issue row's semantic color (error/warning/neutral dot). */
export type IssueSeverity = 'error' | 'warning' | 'info';

export type SecurityIssue = { id: string; label: string; severity: IssueSeverity };

/**
 * Human-readable copy for the `securityStateIssueIds` Chromium emits. Unknown
 * ids fall back to the raw id with neutral severity, so a new Chromium issue
 * id still shows up instead of being silently dropped.
 */
const KNOWN_ISSUES: Record<string, { label: string; severity: IssueSeverity }> = {
  'scheme-is-not-cryptographic': {
    label: 'The connection to this site is not encrypted.',
    severity: 'error',
  },
  'ran-mixed-content': {
    label: 'Active mixed content: a script or other resource was loaded over HTTP.',
    severity: 'error',
  },
  'displayed-mixed-content': {
    label: 'Mixed content: an image or other resource was loaded over HTTP.',
    severity: 'warning',
  },
  'contained-mixed-form': {
    label: 'This page contains a form that submits over HTTP.',
    severity: 'warning',
  },
  'ran-content-with-cert-errors': {
    label: 'This page ran a resource served with certificate errors.',
    severity: 'error',
  },
  'displayed-content-with-cert-errors': {
    label: 'This page displayed a resource served with certificate errors.',
    severity: 'warning',
  },
  'cert-missing-subject-alt-name': {
    label: 'The certificate is missing a subjectAltName extension.',
    severity: 'error',
  },
  'pkp-bypassed': {
    label: 'Public-Key-Pinning was bypassed by a local root certificate.',
    severity: 'warning',
  },
  'is-error-page': {
    label: 'This is an error page.',
    severity: 'info',
  },
};

export function describeSecurityIssue(id: string): SecurityIssue {
  const known = KNOWN_ISSUES[id];
  if (known) return { id, ...known };
  return { id, label: id, severity: 'info' };
}
