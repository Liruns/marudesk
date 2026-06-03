import { useEffect, useRef, useState } from 'react';

/**
 * Seconds elapsed since `active` last became true; resets to 0 when it goes
 * false. Drives the agent's "thinking" timers. Ticks once per second.
 */
export function useElapsedTimer(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      startRef.current = null;
      // Reset via interval-like mechanism to avoid inline setState in effect
      const id = setTimeout(() => setElapsed(0), 0);
      return () => clearTimeout(id);
    }
    startRef.current = Date.now();
    const id = setInterval(() => {
      if (startRef.current !== null) {
        setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(id);
  }, [active]);

  return elapsed;
}

/** Format elapsed seconds as "0:05", "1:23", etc. */
export function formatElapsed(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
