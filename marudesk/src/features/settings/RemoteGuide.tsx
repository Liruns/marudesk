import { useState, type ReactNode } from 'react';
import {
  ChevronRight,
  Lock,
  ScanLine,
  ShieldCheck,
  Smartphone,
  Wifi,
} from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * Where to point users to get the phone companion app. There is no public
 * App Store / Play Store build yet — it's a dev/dogfood build — so this is a
 * deliberate placeholder. Fill it in (docs page, TestFlight, APK release, …)
 * when a real download exists; the guide already renders it as a link.
 */
const MOBILE_APP_URL = 'https://github.com/marudesk/marudesk#mobile-app'; // TODO: real download/help link once a public build ships

type Step = { title: string; body: ReactNode };

const STEPS: Step[] = [
  {
    title: 'Get the marudesk companion app on your phone',
    body: (
      <>
        Install the marudesk phone app, then open it.{' '}
        <a
          href={MOBILE_APP_URL}
          target="_blank"
          rel="noreferrer"
          className="text-accent underline-offset-2 hover:underline"
        >
          Where to get it
        </a>{' '}
        <span className="text-fg-tertiary">(a dev build for now)</span>.
      </>
    ),
  },
  {
    title: 'In the app, tap “Pair with your PC”',
    body: 'It opens the scanner and asks for a name to show on this PC.',
  },
  {
    title: 'Scan the QR above — or type the 8-character code',
    body: 'Point the app’s scanner at the QR on this screen. No camera? Type the code shown under it instead.',
  },
  {
    title: 'Come back to this PC and tap Approve',
    body: 'A request appears here with your phone’s name and a short fingerprint. Approve it only if they match your phone.',
  },
  {
    title: 'Done — your phone can now drive AI Chat',
    body: 'The link is end-to-end encrypted, so it stays private even on open Wi-Fi.',
  },
];

/**
 * Friendly onboarding for phone pairing, shown in Settings → Remote regardless
 * of whether the server is on (so people can read the flow before flipping the
 * toggle). The QR itself only renders elsewhere while pairing is active; this
 * just explains what to do with it — and crucially that the QR is a pairing
 * token, not a web link a normal camera can open.
 */
export function RemoteGuide() {
  return (
    <div className="flex flex-col gap-3">
      <header className="flex flex-col gap-0.5">
        <h3 className="text-body font-medium text-fg-primary">How to connect your phone</h3>
        <p className="text-caption text-fg-tertiary">
          A one-time pairing per device. After that your phone reconnects on its own.
        </p>
      </header>

      {/* The whole point of this task: a generic camera scan of the QR just
          shows base64 text, which confuses people. Make that explicit and loud. */}
      <div className="flex gap-2.5 rounded-lg bg-accent-subtle px-4 py-3">
        <ScanLine size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden />
        <p className="text-caption text-fg-secondary leading-relaxed">
          This QR is a secure pairing token, not a web link. Scanning it with your phone’s
          normal camera will just show text — use the{' '}
          <span className="text-fg-primary">marudesk app’s scanner</span>.
        </p>
      </div>

      <ol className="flex flex-col gap-3 rounded-lg border border-subtle bg-surface-1 px-4 py-4">
        {STEPS.map((step, i) => (
          <li key={step.title} className="flex gap-3">
            <span
              className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-caption font-medium text-accent"
              aria-hidden
            >
              {i + 1}
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-body-sm text-fg-primary">{step.title}</span>
              <span className="text-caption text-fg-tertiary leading-relaxed">{step.body}</span>
            </div>
          </li>
        ))}
      </ol>

      <div className="flex items-center gap-2 px-1 text-caption text-fg-tertiary">
        <Wifi size={13} className="shrink-0" aria-hidden />
        <span>
          Requirements: both devices on the same Wi-Fi / LAN, or Tailscale running on both.
        </span>
      </div>

      <SecurityDetails />
    </div>
  );
}

/** Optional, secondary "how the security works" disclosure — collapsed by default. */
function SecurityDetails() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 self-start text-caption uppercase tracking-wider text-fg-tertiary hover:text-fg-secondary transition-colors duration-fast"
      >
        <ChevronRight size={13} className={cn('transition-transform', open && 'rotate-90')} />
        How the security works
      </button>
      {open ? (
        <div className="flex flex-col gap-2.5 rounded-lg border border-subtle bg-surface-1 px-4 py-3">
          <div className="flex gap-2.5">
            <Lock size={15} className="mt-0.5 shrink-0 text-fg-tertiary" aria-hidden />
            <p className="text-caption text-fg-secondary leading-relaxed">
              Pairing runs an X25519 key exchange and then encrypts every message with
              AES-GCM. Only your two devices hold the shared key, so the link is end-to-end
              encrypted — even on open Wi-Fi, nobody on the network can read it.
            </p>
          </div>
          <div className="flex gap-2.5">
            <ShieldCheck size={15} className="mt-0.5 shrink-0 text-fg-tertiary" aria-hidden />
            <p className="text-caption text-fg-secondary leading-relaxed">
              Holding the key is the proof of identity — there are no passwords to steal. The
              approval step on this PC, where you check the fingerprint, is what stops an
              impostor in the middle from slipping in during the first handshake.
            </p>
          </div>
          <div className="flex gap-2.5">
            <Smartphone size={15} className="mt-0.5 shrink-0 text-fg-tertiary" aria-hidden />
            <p className="text-caption text-fg-secondary leading-relaxed">
              You can revoke any paired phone from the list below at any time; it loses access
              immediately until you pair it again.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
