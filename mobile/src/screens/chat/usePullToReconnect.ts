import { useRef } from 'react';

export function usePullToReconnect(onPull: () => void): (node: HTMLDivElement | null) => void {
  const ref = useRef<HTMLDivElement | null>(null);
  const startY = useRef<number | null>(null);

  return (node: HTMLDivElement | null) => {
    if (ref.current === node) return;
    if (ref.current) {
      ref.current.ontouchstart = null;
      ref.current.ontouchmove = null;
      ref.current.ontouchend = null;
    }
    ref.current = node;
    if (!node) return;

    node.ontouchstart = (event: TouchEvent) => {
      const touch = event.touches.item(0);
      startY.current = node.scrollTop <= 0 && touch ? touch.clientY : null;
    };

    node.ontouchmove = (event: TouchEvent) => {
      const touch = event.touches.item(0);
      if (startY.current === null || !touch) return;
      const dy = touch.clientY - startY.current;
      if (dy > 90) {
        startY.current = null;
        onPull();
      }
    };

    node.ontouchend = () => {
      startY.current = null;
    };
  };
}
