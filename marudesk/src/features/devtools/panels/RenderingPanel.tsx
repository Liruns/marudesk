import {
  useDevtoolsStore,
  type ColorScheme,
  type RenderingState,
  type VisionDeficiency,
} from '../store';
import { useI18n } from '../../../i18n/useI18n';
import type { TranslationKey } from '../../../i18n/messages';

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
    </div>
  );
}
