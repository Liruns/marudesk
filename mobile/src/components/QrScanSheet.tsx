import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { webDetectorCtor, type WebQrDetector } from '../lib/qrScan';

/**
 * Full-screen in-app QR scanner for pairing — the web fallback used when the
 * native ML Kit scanner isn't available (web/PWA builds, or shells without the
 * plugin). Drives the rear camera via getUserMedia and decodes frames with the
 * Shape Detection API. The first decoded QR wins; the camera always shuts down
 * on close/unmount. A camera/permission failure shows a message that points the
 * user at paste entry instead of failing silently.
 */
export function QrScanSheet({
  onScan,
  onClose,
}: {
  readonly onScan: (value: string) => void;
  readonly onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  // The camera lifecycle runs ONCE per mount: `onScan` is read through a ref so
  // an unstable callback identity (an inline arrow in the parent) can't restart
  // getUserMedia mid-scan on every parent re-render.
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let done = false;
    let detecting = false;

    const stop = (): void => {
      if (timer) clearInterval(timer);
      timer = null;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    };

    const start = async (): Promise<void> => {
      const Detector = webDetectorCtor();
      if (!Detector) {
        setError('QR detection isn’t supported here — paste the pairing code instead.');
        return;
      }
      let detector: WebQrDetector;
      try {
        detector = new Detector({ formats: ['qr_code'] });
      } catch {
        setError('QR detection isn’t supported here — paste the pairing code instead.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
      } catch {
        setError('Camera unavailable or permission denied — paste the pairing code instead.');
        return;
      }
      const video = videoRef.current;
      if (done || !video) {
        stop();
        return;
      }
      video.srcObject = stream;
      await video.play().catch(() => {});
      timer = setInterval(() => {
        // HAVE_CURRENT_DATA(2): the video has a decodable frame.
        if (done || detecting || !videoRef.current || video.readyState < 2) return;
        detecting = true;
        detector
          .detect(video)
          .then((codes) => {
            const value = codes[0]?.rawValue;
            if (value && !done) {
              done = true;
              stop();
              onScanRef.current(value);
            }
          })
          .catch(() => {
            // A frame that won't decode is normal — keep scanning.
          })
          .finally(() => {
            detecting = false;
          });
      }, 250);
    };

    void start();
    return () => {
      done = true;
      stop();
    };
  }, []);

  return (
    <div className="qr-scan" role="dialog" aria-modal="true" aria-label="Scan pairing QR">
      <video ref={videoRef} className="qr-scan__video" muted playsInline />
      <div className="qr-scan__chrome">
        <div className="qr-scan__top">
          <span>Point the camera at the QR on your PC</span>
          <button className="icon-button" aria-label="Close scanner" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {error ? (
          <div className="qr-scan__error">
            <p>{error}</p>
            <button className="btn btn-secondary" onClick={onClose}>
              Enter it manually
            </button>
          </div>
        ) : (
          <div className="qr-scan__frame" aria-hidden />
        )}
      </div>
    </div>
  );
}
