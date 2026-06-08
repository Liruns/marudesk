import { useEffect, useLayoutEffect, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { useI18n } from '../../i18n/useI18n';
import { TOUR_STEPS } from './steps';
import { useTourStore } from './tourStore';

type Rect = { top: number; left: number; width: number; height: number };

const TIP_W = 320;
const TIP_H = 156;
const MARGIN = 12;
const HOLE_PAD = 6;

function measure(selector?: string): Rect | null {
  if (!selector) return null;
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

/** Place the tooltip below the hole (else above; else centered), clamped to view. */
function tipPosition(hole: Rect | null): CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!hole) {
    return { top: Math.max(MARGIN, (vh - TIP_H) / 2), left: Math.max(MARGIN, (vw - TIP_W) / 2) };
  }
  let top = hole.top + hole.height + MARGIN;
  if (top + TIP_H > vh - MARGIN) top = hole.top - TIP_H - MARGIN;
  top = Math.min(Math.max(MARGIN, top), Math.max(MARGIN, vh - TIP_H - MARGIN));
  let left = hole.left + hole.width / 2 - TIP_W / 2;
  left = Math.min(Math.max(MARGIN, left), Math.max(MARGIN, vw - TIP_W - MARGIN));
  return { top, left };
}

const ghostBtn =
  'rounded-md px-2.5 py-1 text-caption text-fg-secondary hover:text-fg-primary hover:bg-surface-2 transition-colors duration-fast';
const primaryBtn =
  'rounded-md bg-accent px-3 py-1 text-caption font-medium text-white transition-opacity duration-fast hover:opacity-90';

export function Tour() {
  const open = useTourStore((s) => s.open);
  const close = useTourStore((s) => s.close);
  const { t } = useI18n();
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);

  // Reset to the first step each time the tour opens. Done during render (the
  // store-the-previous-prop pattern) rather than in an effect, so there's no
  // cascading-render round-trip — see react.dev "You Might Not Need an Effect".
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setIndex(0);
  }

  const step = open ? TOUR_STEPS[index] : undefined;

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => setRect(measure(step?.target));
    update();
    window.addEventListener('resize', update);
    // Re-measure periodically so the spotlight tracks async layout shifts
    // (panels collapsing/opening) without wiring observers to every surface.
    const id = window.setInterval(update, 300);
    return () => {
      window.removeEventListener('resize', update);
      window.clearInterval(id);
    };
  }, [open, step?.target]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, close]);

  if (!open || !step) return null;

  const last = index === TOUR_STEPS.length - 1;
  const hole: Rect | null = rect
    ? {
        top: rect.top - HOLE_PAD,
        left: rect.left - HOLE_PAD,
        width: rect.width + HOLE_PAD * 2,
        height: rect.height + HOLE_PAD * 2,
      }
    : null;

  return createPortal(
    <div className="fixed inset-0 z-[100]">
      {hole ? (
        <>
          {/* Four dim panels leave the anchor crisp; a ring outlines it. */}
          <div className="absolute left-0 right-0 top-0 bg-black/55" style={{ height: Math.max(0, hole.top) }} />
          <div className="absolute left-0 right-0 bottom-0 bg-black/55" style={{ top: hole.top + hole.height }} />
          <div className="absolute bg-black/55" style={{ top: hole.top, left: 0, width: Math.max(0, hole.left), height: hole.height }} />
          <div className="absolute bg-black/55" style={{ top: hole.top, left: hole.left + hole.width, right: 0, height: hole.height }} />
          <div
            className="absolute rounded-md ring-2 ring-accent pointer-events-none"
            style={{ top: hole.top, left: hole.left, width: hole.width, height: hole.height }}
          />
        </>
      ) : (
        <div className="absolute inset-0 bg-black/55" />
      )}

      <div
        role="dialog"
        aria-label={t(step.title)}
        className="absolute flex flex-col gap-3 rounded-lg border border-default bg-surface-1 p-4 shadow-lifted"
        style={{ width: TIP_W, ...tipPosition(hole) }}
      >
        <div className="flex flex-col gap-1">
          <h2 className="text-body-sm font-semibold text-fg-primary">{t(step.title)}</h2>
          <p className="text-caption text-fg-tertiary">{t(step.body)}</p>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5" aria-hidden>
            {TOUR_STEPS.map((s, i) => (
              <span
                key={s.title}
                className={cn('size-1.5 rounded-pill', i === index ? 'bg-accent' : 'bg-fg-tertiary/40')}
              />
            ))}
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={close} className={ghostBtn}>
              {t('tour.controls.skip')}
            </button>
            {index > 0 ? (
              <button type="button" onClick={() => setIndex((i) => i - 1)} className={ghostBtn}>
                {t('tour.controls.back')}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => (last ? close() : setIndex((i) => i + 1))}
              className={primaryBtn}
            >
              {last ? t('tour.controls.done') : t('tour.controls.next')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
