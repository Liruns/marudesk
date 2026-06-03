import { useEffect, useState } from 'react';

/**
 * Whole seconds remaining until `expiresAt` (epoch ms), clamped at 0. Ticks once
 * per second. Used for pairing-code / token expiry countdowns.
 */
export function useCountdown(expiresAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}
