import {
  useDevtoolsStore,
  type ColorScheme,
  type RenderingState,
  type VisionDeficiency,
} from '../store';

/**
 * Rendering panel: cheap, high-value debugging overlays + media/vision
 * emulation. All toggles are sticky store preferences re-applied on re-attach
 * (`_applyRendering`); the booleans drive the Overlay.setShow* family, the
 * selects drive Emulation.setEmulatedMedia / setEmulatedVisionDeficiency.
 */

const OVERLAY_TOGGLES: { key: 'paintRects' | 'layoutShiftRegions' | 'fpsCounter' | 'scrollBottleneck' | 'webVitals'; label: string }[] = [
  { key: 'paintRects', label: 'Paint flashing' },
  { key: 'layoutShiftRegions', label: 'Layout shift regions' },
  { key: 'fpsCounter', label: 'Frame rate (FPS) counter' },
  { key: 'scrollBottleneck', label: 'Scrolling performance issues' },
  { key: 'webVitals', label: 'Core Web Vitals' },
];

const COLOR_SCHEMES: { id: ColorScheme; label: string }[] = [
  { id: 'no-override', label: 'No override' },
  { id: 'light', label: 'light' },
  { id: 'dark', label: 'dark' },
];

const VISION_DEFICIENCIES: { id: VisionDeficiency; label: string }[] = [
  { id: 'none', label: 'No emulation' },
  { id: 'blurredVision', label: 'Blurred vision' },
  { id: 'protanopia', label: 'Protanopia' },
  { id: 'deuteranopia', label: 'Deuteranopia' },
  { id: 'tritanopia', label: 'Tritanopia' },
  { id: 'achromatopsia', label: 'Achromatopsia' },
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
  const r = useDevtoolsStore((s) => s.rendering);
  const set = (patch: Partial<RenderingState>) =>
    useDevtoolsStore.getState().setRendering(patch);

  return (
    <div className="h-full overflow-auto py-1 divide-y divide-subtle/40">
      {OVERLAY_TOGGLES.map((t) => (
        <Row key={t.key} label={t.label}>
          <input
            type="checkbox"
            checked={r[t.key]}
            onChange={(e) => set({ [t.key]: e.target.checked })}
            className="accent-accent"
          />
        </Row>
      ))}
      <Row label="Emulate CSS prefers-color-scheme">
        <select
          value={r.colorScheme}
          onChange={(e) => set({ colorScheme: e.target.value as ColorScheme })}
          aria-label="Emulate prefers-color-scheme"
          className={SELECT_CLASS}
        >
          {COLOR_SCHEMES.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Emulate CSS prefers-reduced-motion: reduce">
        <input
          type="checkbox"
          checked={r.reducedMotion}
          onChange={(e) => set({ reducedMotion: e.target.checked })}
          className="accent-accent"
        />
      </Row>
      <Row label="Emulate print media type">
        <input
          type="checkbox"
          checked={r.printMedia}
          onChange={(e) => set({ printMedia: e.target.checked })}
          className="accent-accent"
        />
      </Row>
      <Row label="Emulate vision deficiencies">
        <select
          value={r.visionDeficiency}
          onChange={(e) => set({ visionDeficiency: e.target.value as VisionDeficiency })}
          aria-label="Emulate vision deficiency"
          className={SELECT_CLASS}
        >
          {VISION_DEFICIENCIES.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </Row>
    </div>
  );
}
