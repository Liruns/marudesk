import {
  useDevtoolsStore,
  type ColorScheme,
  type RenderingState,
  type VisionDeficiency,
} from '../store';
import { useI18n } from '../../../i18n/useI18n';
import type { TranslationKey } from '../../../i18n/messages';
import { cn } from '../../../lib/cn';
import { useCoverageStore } from '../coverage-store';
import { truncateMiddle, usagePercent, type CoverageRow } from '../coverage-utils';
import { fmtBytes } from './network-utils';

/**
 * Rendering panel: cheap, high-value debugging overlays + media/vision
 * emulation. All toggles are sticky store preferences re-applied on re-attach
 * (`_applyRendering`); the booleans drive the Overlay.setShow* family, the
 * selects drive Emulation.setEmulatedMedia / setEmulatedVisionDeficiency.
 */

const OVERLAY_TOGGLES: {
  key: 'paintRects' | 'layoutShiftRegions' | 'fpsCounter' | 'scrollBottleneck' | 'webVitals';
  labelKey: TranslationKey;
}[] = [
  { key: 'paintRects', labelKey: 'devtools.rendering.paintFlashing' },
  { key: 'layoutShiftRegions', labelKey: 'devtools.rendering.layoutShiftRegions' },
  { key: 'fpsCounter', labelKey: 'devtools.rendering.fpsCounter' },
  { key: 'scrollBottleneck', labelKey: 'devtools.rendering.scrollBottleneck' },
  { key: 'webVitals', labelKey: 'devtools.rendering.webVitals' },
];

const COLOR_SCHEMES: { id: ColorScheme; labelKey: TranslationKey }[] = [
  { id: 'no-override', labelKey: 'devtools.rendering.noOverride' },
  { id: 'light', labelKey: 'devtools.rendering.light' },
  { id: 'dark', labelKey: 'devtools.rendering.dark' },
];

const VISION_DEFICIENCIES: { id: VisionDeficiency; labelKey: TranslationKey }[] = [
  { id: 'none', labelKey: 'devtools.rendering.noEmulation' },
  { id: 'blurredVision', labelKey: 'devtools.rendering.blurredVision' },
  { id: 'protanopia', labelKey: 'devtools.rendering.protanopia' },
  { id: 'deuteranopia', labelKey: 'devtools.rendering.deuteranopia' },
  { id: 'tritanopia', labelKey: 'devtools.rendering.tritanopia' },
  { id: 'achromatopsia', labelKey: 'devtools.rendering.achromatopsia' },
];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-3 px-3 py-1.5 text-body-sm text-fg-secondary cursor-pointer select-none">
      <span>{label}</span>
      {children}
    </label>
  );
}

const SELECT_CLASS =
  'h-6 rounded bg-surface-2 px-1 text-caption text-fg-secondary focus:outline-none focus:ring-1 focus:ring-accent/50';

const COVERAGE_BUTTON_CLASS =
  'h-6 px-2 rounded bg-surface-2 text-caption text-fg-secondary hover:text-fg-primary hover:bg-surface-3 transition-colors duration-fast disabled:opacity-40 disabled:hover:bg-surface-2 disabled:hover:text-fg-secondary';

function CoverageRowView({ row }: { row: CoverageRow }) {
  const pct = usagePercent(row);
  return (
    <div className="flex items-center gap-2 text-caption">
      <span
        title={row.url}
        className="w-[38%] shrink-0 font-mono text-fg-secondary whitespace-nowrap overflow-hidden"
      >
        {truncateMiddle(row.url, 48)}
      </span>
      <span className="w-8 shrink-0 text-fg-tertiary uppercase">{row.kind}</span>
      <div className="flex-1 h-2 bg-surface-3 rounded-sm overflow-hidden" aria-hidden>
        <div className="h-full bg-accent/70 rounded-sm" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-44 shrink-0 text-right tabular-nums text-fg-tertiary whitespace-nowrap">
        {fmtBytes(row.usedBytes)} / {fmtBytes(row.totalBytes)}
        <span className="text-fg-secondary"> · {pct.toFixed(0)}%</span>
      </span>
    </div>
  );
}

/**
 * Coverage section: arm Profiler precise coverage (JS) + CSS rule-usage
 * tracking, then on stop render per-script / per-stylesheet used-vs-total
 * bytes, biggest unused share first. Lives in the Rendering panel; the state
 * sits in its own small store (coverage-store) so a recording survives
 * switching panels.
 */
function CoverageSection() {
  const recording = useCoverageStore((s) => s.recording);
  const busy = useCoverageStore((s) => s.busy);
  const rows = useCoverageStore((s) => s.rows);
  const attached = useDevtoolsStore((s) => s.session === 'attached');

  return (
    <div className="px-3 py-2 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-body-sm text-fg-secondary">Coverage</span>
        <div className="flex items-center gap-1.5">
          {rows.length > 0 && !recording ? (
            <button
              type="button"
              onClick={() => useCoverageStore.getState().clear()}
              className={COVERAGE_BUTTON_CLASS}
            >
              Clear
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy || (!recording && !attached)}
            title={
              !recording && !attached
                ? 'Coverage needs an attached DevTools session.'
                : undefined
            }
            onClick={() => {
              const s = useCoverageStore.getState();
              if (s.recording) void s.stop();
              else void s.start();
            }}
            className={cn(
              COVERAGE_BUTTON_CLASS,
              recording && 'text-error hover:text-error',
            )}
          >
            {recording ? 'Stop' : 'Start'}
          </button>
        </div>
      </div>
      {recording ? (
        <div className="text-caption text-fg-tertiary">
          Recording coverage. Exercise the page, then stop to see usage.
        </div>
      ) : rows.length === 0 ? (
        <div className="text-caption text-fg-tertiary">
          Start instrumentation, exercise the page, then stop to see per-file JS
          and CSS usage.
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {rows.map((row) => (
            <CoverageRowView key={row.id} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

export function RenderingPanel() {
  const { t } = useI18n();
  const r = useDevtoolsStore((s) => s.rendering);
  const set = (patch: Partial<RenderingState>) =>
    useDevtoolsStore.getState().setRendering(patch);

  return (
    <div className="h-full overflow-auto py-1 divide-y divide-subtle/40">
      {OVERLAY_TOGGLES.map((toggle) => (
        <Row key={toggle.key} label={t(toggle.labelKey)}>
          <input
            type="checkbox"
            checked={r[toggle.key]}
            onChange={(e) => set({ [toggle.key]: e.target.checked })}
            className="accent-accent"
          />
        </Row>
      ))}
      <Row label={t('devtools.rendering.colorScheme')}>
        <select
          value={r.colorScheme}
          onChange={(e) => set({ colorScheme: e.target.value as ColorScheme })}
          aria-label={t('devtools.rendering.colorSchemeAria')}
          className={SELECT_CLASS}
        >
          {COLOR_SCHEMES.map((o) => (
            <option key={o.id} value={o.id}>
              {t(o.labelKey)}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t('devtools.rendering.reducedMotion')}>
        <input
          type="checkbox"
          checked={r.reducedMotion}
          onChange={(e) => set({ reducedMotion: e.target.checked })}
          className="accent-accent"
        />
      </Row>
      <Row label={t('devtools.rendering.printMedia')}>
        <input
          type="checkbox"
          checked={r.printMedia}
          onChange={(e) => set({ printMedia: e.target.checked })}
          className="accent-accent"
        />
      </Row>
      <Row label={t('devtools.rendering.visionDeficiencies')}>
        <select
          value={r.visionDeficiency}
          onChange={(e) => set({ visionDeficiency: e.target.value as VisionDeficiency })}
          aria-label={t('devtools.rendering.visionDeficiencyAria')}
          className={SELECT_CLASS}
        >
          {VISION_DEFICIENCIES.map((o) => (
            <option key={o.id} value={o.id}>
              {t(o.labelKey)}
            </option>
          ))}
        </select>
      </Row>
      <CoverageSection />
    </div>
  );
}
