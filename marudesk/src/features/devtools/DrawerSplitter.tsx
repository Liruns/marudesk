import type { PointerEvent as ReactPointerEvent } from 'react';
import { useI18n } from '../../i18n/useI18n';
import { useDevtoolsStore } from './store';

const DRAWER_MIN = 80;

export function DrawerSplitter() {
  const { t } = useI18n();
  const onDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      const wrapper = (e.target as HTMLElement).closest('[data-devtools-content]');
      const rect = wrapper?.getBoundingClientRect();
      if (!rect) return;
      const next = rect.bottom - ev.clientY;
      const max = rect.height - DRAWER_MIN;
      useDevtoolsStore.getState().setDrawerHeight(Math.min(Math.max(next, DRAWER_MIN), max));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div
      onPointerDown={onDown}
      role="separator"
      aria-orientation="horizontal"
      aria-label={t('devtools.resizeDrawer')}
      className="shrink-0 h-1 cursor-row-resize bg-transparent hover:bg-accent/50 active:bg-accent transition-colors"
    />
  );
}

export { DRAWER_MIN };
