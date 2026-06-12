/**
 * QR scanning seam for the pairing flow, in preference order:
 *
 *  1. Native ML Kit (`@capacitor-mlkit/barcode-scanning`) when running inside a
 *     Capacitor shell — the system "code scanner" UI, no camera permission needed.
 *  2. The in-app camera scanner (components/QrScanSheet.tsx) driven by the Shape
 *     Detection API ({@link webDetectorCtor}) — covers web/PWA builds and shells
 *     where the native plugin can't run.
 *  3. Paste entry (always available on the Connect screen).
 *
 * Every step degrades explicitly: the caller learns WHY scanning didn't happen
 * ('cancelled' vs 'unavailable') so the UI can fall through without lying.
 */

export type NativeScanResult =
  | { kind: 'scanned'; value: string }
  | { kind: 'cancelled' }
  | { kind: 'unavailable' };

function isNativePlatform(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return Boolean(cap?.isNativePlatform?.());
}

/**
 * Scan one QR with the native ML Kit plugin. Resolves 'unavailable' when not in
 * a native shell, the plugin/device doesn't support it, or the Google scanner
 * module isn't installed yet (an install is kicked off in the background so the
 * NEXT attempt succeeds); 'cancelled' when the user backed out of the scan UI.
 */
export async function scanWithNativePlugin(): Promise<NativeScanResult> {
  if (!isNativePlatform()) return { kind: 'unavailable' };
  try {
    const { BarcodeScanner, BarcodeFormat } = await import('@capacitor-mlkit/barcode-scanning');
    const { supported } = await BarcodeScanner.isSupported();
    if (!supported) return { kind: 'unavailable' };
    const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
    const value = barcodes[0]?.rawValue;
    return value ? { kind: 'scanned', value } : { kind: 'cancelled' };
  } catch (err) {
    const message = err instanceof Error ? err.message.toLowerCase() : '';
    if (message.includes('cancel')) return { kind: 'cancelled' };
    // Most likely the Google barcode-scanner module isn't installed yet (first
    // run on this device). Start the install in the background, best-effort.
    void import('@capacitor-mlkit/barcode-scanning')
      .then(({ BarcodeScanner }) => BarcodeScanner.installGoogleBarcodeScannerModule())
      .catch(() => {});
    return { kind: 'unavailable' };
  }
}

/* ── web fallback: Shape Detection API (BarcodeDetector) + getUserMedia ─────── */

/** The subset of the Shape Detection API the scan sheet uses (not in TS's DOM lib). */
export type WebQrDetector = {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
};

type WebDetectorCtor = new (options?: { formats?: string[] }) => WebQrDetector;

/** The BarcodeDetector constructor when this WebView/browser ships it, else null. */
export function webDetectorCtor(): WebDetectorCtor | null {
  const ctor = (globalThis as { BarcodeDetector?: WebDetectorCtor }).BarcodeDetector;
  return typeof ctor === 'function' ? ctor : null;
}

/** Whether the in-app camera scanner can run here (detector + camera API). */
export function webCameraScanSupported(): boolean {
  return webDetectorCtor() !== null && typeof navigator.mediaDevices?.getUserMedia === 'function';
}
