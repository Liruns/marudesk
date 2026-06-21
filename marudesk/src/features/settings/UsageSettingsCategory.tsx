import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useI18n } from '../../i18n/useI18n';
import { cn } from '../../lib/cn';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { Section } from './SettingsControls';
import { ProviderGlyph } from '../providers/ProviderGlyph';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type UsageStatus = 'ok' | 'warning' | 'exhausted' | 'unknown';
type UsageUnit = 'percent' | 'tokens' | 'requests' | 'usd' | string;

interface UsageAmount {
  used?: number;
  limit?: number;
  remaining?: number;
  usedFraction?: number;
  remainingFraction?: number;
  unit: UsageUnit;
}

interface UsageWindow {
  id: string;
  label: string;
  resetsAt?: number;
}

interface UsageLimit {
  id: string;
  label: string;
  window?: UsageWindow;
  amount: UsageAmount;
  status?: UsageStatus;
}

interface UsageReport {
  provider: string;
  fetchedAt: number;
  limits: UsageLimit[];
  identity?: { accountId?: string; email?: string };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Compute the used fraction (0-1) from whichever fields are populated. */
function computeFraction(amount: UsageAmount): number | null {
  if (amount.usedFraction != null) return amount.usedFraction;
  if (amount.used != null && amount.limit != null && amount.limit > 0) {
    return amount.used / amount.limit;
  }
  if (amount.remainingFraction != null) return 1 - amount.remainingFraction;
  return null;
}

/** Derive a status when the backend doesn't explicitly provide one. */
function deriveStatus(amount: UsageAmount, explicit?: UsageStatus): UsageStatus {
  if (explicit && explicit !== 'unknown') return explicit;
  const frac = computeFraction(amount);
  if (frac == null) return 'unknown';
  if (frac >= 1) return 'exhausted';
  if (frac >= 0.9) return 'warning';
  return 'ok';
}

/** Format a number with locale-aware compact notation. */
function fmtNumber(n: number, unit: UsageUnit): string {
  if (unit === 'usd') return `$${n.toFixed(2)}`;
  if (unit === 'percent') return `${(n * 100).toFixed(1)}%`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Relative duration string, e.g. "2h 15m". */
function formatRelativeTime(epochMs: number): string {
  const diff = epochMs - Date.now();
  if (diff <= 0) return '<1m';
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours > 0) return `${hours}h ${remainingMinutes}m`;
  return `${remainingMinutes}m`;
}

/** Bar color classes keyed by status. */
const BAR_COLORS: Record<UsageStatus, string> = {
  ok: 'bg-success',
  warning: 'bg-warning',
  exhausted: 'bg-error',
  unknown: 'bg-fg-tertiary',
};

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function LimitBar({ limit }: { readonly limit: UsageLimit }) {
  const { t } = useI18n();
  const status = deriveStatus(limit.amount, limit.status);
  const fraction = computeFraction(limit.amount);
  const pct = fraction != null ? Math.min(fraction * 100, 100) : 0;

  return (
    <div className="flex flex-col gap-1.5">
      {/* Label row */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-body-sm text-fg-primary">{limit.label}</span>
        <div className="flex items-center gap-2">
          {limit.amount.used != null && limit.amount.limit != null ? (
            <span className="text-caption text-fg-tertiary tabular-nums">
              {fmtNumber(limit.amount.used, limit.amount.unit)}
              {' / '}
              {fmtNumber(limit.amount.limit, limit.amount.unit)}
            </span>
          ) : limit.amount.remaining != null ? (
            <span className="text-caption text-fg-tertiary tabular-nums">
              {fmtNumber(limit.amount.remaining, limit.amount.unit)} {t('settings.usage.remaining')}
            </span>
          ) : null}
          <Badge
            variant={
              status === 'ok'
                ? 'success'
                : status === 'warning'
                  ? 'warning'
                  : status === 'exhausted'
                    ? 'error'
                    : 'neutral'
            }
          >
            {status === 'ok'
              ? t('settings.usage.limitOk')
              : status === 'warning'
                ? t('settings.usage.limitWarning')
                : status === 'exhausted'
                  ? t('settings.usage.limitExhausted')
                  : '—'}
          </Badge>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-2 rounded-full bg-surface-3 overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all duration-300', BAR_COLORS[status])}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Reset time */}
      {limit.window?.resetsAt ? (
        <span className="text-caption text-fg-tertiary">
          {t('settings.usage.resetsIn')} {formatRelativeTime(limit.window.resetsAt)}
          {limit.window.label ? ` (${limit.window.label})` : ''}
        </span>
      ) : null}
    </div>
  );
}

function ProviderCard({ report }: { readonly report: UsageReport }) {
  const { t } = useI18n();

  return (
    <Section>
      <div className="flex flex-col gap-3 px-4 py-3">
        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <ProviderGlyph
              provider={report.provider as never}
              label={report.provider}
              size={20}
            />
            <span className="text-body-sm font-medium text-fg-primary">
              {report.provider}
            </span>
          </div>
          {report.identity?.email ? (
            <span className="text-caption text-fg-tertiary">
              {t('settings.usage.identity')}: {report.identity.email}
            </span>
          ) : null}
        </div>

        {/* Limits */}
        {report.limits.length > 0 ? (
          <div className="flex flex-col gap-3">
            {report.limits.map((limit) => (
              <LimitBar key={limit.id} limit={limit} />
            ))}
          </div>
        ) : (
          <p className="text-caption text-fg-tertiary">{t('settings.usage.noLimits')}</p>
        )}

        {/* Last fetched */}
        <span className="text-caption text-fg-tertiary">
          {t('settings.usage.lastFetched')}:{' '}
          {new Date(report.fetchedAt).toLocaleTimeString()}
        </span>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function UsageCategory() {
  const { t } = useI18n();
  const [reports, setReports] = useState<UsageReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchUsage = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const data: UsageReport[] = await window.marudesk.invoke('usage:fetch-all');
      setReports(data);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial load: fetchUsage() setState's a loading flag then awaits IPC, so
    // this fetch-on-mount synchronizes with an external system rather than
    // triggering a synchronous render cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchUsage();
  }, [fetchUsage]);

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <h3 className="text-body font-medium text-fg-primary">
          {t('settings.usage.title')}
        </h3>
        <Button
          variant="secondary"
          size="sm"
          leadingIcon={loading ? <Spinner size={14} /> : <RefreshCw size={14} />}
          disabled={loading}
          onClick={() => void fetchUsage()}
        >
          {loading ? t('settings.usage.refreshing') : t('settings.usage.refresh')}
        </Button>
      </div>

      {/* Loading state */}
      {loading && reports.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Spinner size={24} />
        </div>
      ) : error ? (
        /* Error state */
        <Section>
          <div className="flex items-center gap-2 px-4 py-3 text-body-sm text-error">
            <AlertTriangle size={16} />
            {t('settings.usage.fetchError')}
          </div>
        </Section>
      ) : reports.length === 0 ? (
        /* Empty state */
        <Section>
          <div className="px-4 py-6 text-center">
            <p className="text-body-sm text-fg-tertiary">
              {t('settings.usage.empty')}
            </p>
          </div>
        </Section>
      ) : (
        /* Provider cards */
        reports.map((report) => (
          <ProviderCard key={report.provider} report={report} />
        ))
      )}
    </div>
  );
}
