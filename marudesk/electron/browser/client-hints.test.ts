import { describe, expect, it } from 'vitest';
import { withChromeBrand } from './client-hints.ts';

// Electron's low-entropy brand list: Chromium + GREASE, no "Google Chrome".
const LOW = '"Chromium";v="148", "Not?A_Brand";v="24"';
// High-entropy list (Sec-CH-UA-Full-Version-List): full four-part versions.
const FULL = '"Chromium";v="148.0.0.0", "Not?A_Brand";v="24.0.0.0"';

describe('withChromeBrand', () => {
  it('adds a Google Chrome brand mirroring the Chromium major version', () => {
    expect(withChromeBrand(LOW)).toBe(
      '"Chromium";v="148", "Google Chrome";v="148", "Not?A_Brand";v="24"',
    );
  });

  it('mirrors the full version on Sec-CH-UA-Full-Version-List', () => {
    expect(withChromeBrand(FULL)).toBe(
      '"Chromium";v="148.0.0.0", "Google Chrome";v="148.0.0.0", "Not?A_Brand";v="24.0.0.0"',
    );
  });

  it('keeps the real Chromium version (never forges a different one)', () => {
    const out = withChromeBrand(LOW);
    expect(out).toContain('"Chromium";v="148"');
    expect(out).toContain('"Google Chrome";v="148"');
  });

  it('is idempotent — re-running on a normalized value is a no-op', () => {
    const once = withChromeBrand(LOW);
    expect(withChromeBrand(once)).toBe(once);
  });

  it('leaves a real Chrome brand list untouched', () => {
    const real = '"Chromium";v="148", "Google Chrome";v="148", "Not?A_Brand";v="24"';
    expect(withChromeBrand(real)).toBe(real);
  });

  it('tolerates a list with no Chromium entry (nothing to clone)', () => {
    const odd = '"Not?A_Brand";v="24"';
    expect(withChromeBrand(odd)).toBe(odd);
  });

  it('tolerates an empty value', () => {
    expect(withChromeBrand('')).toBe('');
  });

  it('tolerates a missing space after the semicolon', () => {
    expect(withChromeBrand('"Chromium";v="148"')).toBe(
      '"Chromium";v="148", "Google Chrome";v="148"',
    );
  });
});
