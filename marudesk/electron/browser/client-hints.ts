/**
 * User-Agent Client Hints normalization for the embedded web tabs.
 *
 * Electron advertises its low-entropy UA-CH brand list as Chromium + a GREASE
 * brand only — e.g.
 *
 *   Sec-CH-UA: "Chromium";v="148", "Not?A_Brand";v="24"
 *
 * A real Google Chrome additionally carries a `"Google Chrome"` brand at the
 * same major version. The *absence* of that recognized browser brand is a
 * reliable fingerprint of an embedded/automated Chromium, and some sign-in gates
 * — notably Google's "this browser or app may not be secure" / disallowed_useragent
 * block — read `Sec-CH-UA` and reject brand lists that name no real browser, even
 * after the UA *string* has been cleaned (see ./user-agent).
 *
 * We mirror the UA-string strategy exactly: keep every real entry untouched —
 * same brands, same TRUTHFUL versions, same ordering/whitespace — and only ADD a
 * `"Google Chrome"` entry that clones the `"Chromium"` entry's version. We never
 * forge a version the bundled engine doesn't actually ship.
 *
 * The same logic applies to both `Sec-CH-UA` (major version, e.g. v="148") and
 * `Sec-CH-UA-Full-Version-List` (full version, e.g. v="148.0.0.0") because it
 * copies whatever version the Chromium entry carries.
 */

const CHROME_BRAND = 'Google Chrome';

/**
 * Given a `Sec-CH-UA` / `Sec-CH-UA-Full-Version-List` header value, return it
 * with a `"Google Chrome"` brand mirroring the `"Chromium"` entry's version,
 * inserted right after it. Everything else is preserved verbatim.
 *
 * Idempotent (a list that already names Google Chrome — a real Chrome, or an
 * already-normalized value — is returned unchanged) and tolerant of a
 * missing/garbled Chromium entry (returned unchanged, since there is no truthful
 * version to clone).
 */
export function withChromeBrand(value: string): string {
  if (!value || value.includes(`"${CHROME_BRAND}"`)) return value;
  const chromium = /"Chromium";\s*v="([^"]*)"/.exec(value);
  if (!chromium) return value;
  const inserted = `, "${CHROME_BRAND}";v="${chromium[1]}"`;
  const end = chromium.index + chromium[0].length;
  return value.slice(0, end) + inserted + value.slice(end);
}
