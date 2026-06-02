import { useId } from 'react';
import type { ProviderId } from '../../../shared/providers';
import { providerVisual } from './providerVisual';

/**
 * Provider brand mark for the model picker / provider cards. Renders a real,
 * recognizable brand glyph per provider (a clean inline SVG in the brand's
 * color) instead of a bare letter — that letter-in-a-tinted-box was the v5
 * picker reading as 촌스러운/amateur. The marks are intentionally simple,
 * geometric evocations (sunburst, sparkle, rosette, X, llama) so they stay crisp
 * at 16–20px; the model label beside them stays the real identifier.
 *
 * A `custom:<id>` endpoint has no brand, so it falls back to a tasteful monogram
 * tile (one letter from its label) — see {@link providerVisual}. Same props as
 * before, so every call site (ModelPalette, ProvidersSettings, the chat's
 * ProviderModelBar) is unchanged.
 */
export function ProviderGlyph({
  provider,
  label,
  size = 18,
  className,
}: {
  provider: ProviderId;
  label?: string;
  size?: number;
  className?: string;
}) {
  const kind = brandKind(provider);
  if (kind === 'generic') {
    return <MonogramTile label={label} size={size} className={className} />;
  }
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center ${className ?? ''}`}
      style={{ width: size, height: size }}
    >
      <BrandMark kind={kind} size={size} />
    </span>
  );
}

type BrandKind = 'anthropic' | 'openai' | 'gemini' | 'xai' | 'ollama' | 'generic';

/** Map a provider id to its brand mark. Subscription twins share a parent mark. */
function brandKind(provider: ProviderId): BrandKind {
  switch (provider) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
    case 'openai-codex':
      return 'openai';
    case 'google':
    case 'google-caa':
      return 'gemini';
    case 'xai':
      return 'xai';
    case 'ollama':
      return 'ollama';
    default:
      return 'generic'; // custom:<id> endpoints (OpenRouter / LM Studio / …)
  }
}

const ANTHROPIC = '#D97757'; // Claude coral

function BrandMark({ kind, size }: { kind: Exclude<BrandKind, 'generic'>; size: number }) {
  const gradId = useId();
  const common = { width: size, height: size, viewBox: '0 0 24 24' } as const;

  switch (kind) {
    // Claude — the coral radial spark (8-ray burst).
    case 'anthropic':
      return (
        <svg {...common} fill="none" aria-hidden>
          <g stroke={ANTHROPIC} strokeWidth={2.1} strokeLinecap="round">
            <path d="M12 3.5v17M3.5 12h17M6 6l12 12M18 6 6 18" />
          </g>
        </svg>
      );
    // OpenAI — interlocking-loop rosette (3 ellipses at 60°), monochrome.
    case 'openai':
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
          <ellipse cx={12} cy={12} rx={4.1} ry={8.6} />
          <ellipse cx={12} cy={12} rx={4.1} ry={8.6} transform="rotate(60 12 12)" />
          <ellipse cx={12} cy={12} rx={4.1} ry={8.6} transform="rotate(120 12 12)" />
        </svg>
      );
    // Gemini — 4-point concave sparkle in the Google blue→purple gradient.
    case 'gemini':
      return (
        <svg {...common} aria-hidden>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#4285F4" />
              <stop offset="0.5" stopColor="#9168C0" />
              <stop offset="1" stopColor="#D96570" />
            </linearGradient>
          </defs>
          <path
            d="M12 1.5Q12 12 1.5 12Q12 12 12 22.5Q12 12 22.5 12Q12 12 12 1.5Z"
            fill={`url(#${gradId})`}
          />
        </svg>
      );
    // xAI / Grok — the angular X, near-white.
    case 'xai':
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth={2.3} strokeLinecap="round" aria-hidden>
          <path d="M5 5 19 19M19 5 5 19" />
        </svg>
      );
    // Ollama — minimal llama head (two ears + muzzle), neutral.
    case 'ollama':
      return (
        <svg {...common} fill="currentColor" aria-hidden>
          <path d="M7.4 3.1c.6-.2 1.1.3 1.2.9l.5 3.1h5.8l.5-3.1c.1-.6.6-1.1 1.2-.9.5.2.7.8.6 1.4l-.6 3.2c1 .5 1.7 1.6 1.7 2.8v6.1A3.2 3.2 0 0 1 16.4 20H15v-2.2a3 3 0 1 0-6 0V20H7.6a3.2 3.2 0 0 1-3.2-3.4v-6.1c0-1.2.7-2.3 1.7-2.8l-.6-3.2c-.1-.6.1-1.2.6-1.4Z" />
          <circle cx={9.6} cy={11} r={1} fill="var(--surface-page)" />
          <circle cx={14.4} cy={11} r={1} fill="var(--surface-page)" />
        </svg>
      );
  }
}

/** Letter tile for brand-less custom endpoints — refined from the old monogram. */
function MonogramTile({
  label,
  size,
  className,
}: {
  label?: string;
  size: number;
  className?: string;
}) {
  const v = providerVisual('custom:_', label);
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-md font-semibold leading-none ${className ?? ''}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.5),
        color: v.color,
        backgroundColor: `${v.color}1f`,
        boxShadow: `inset 0 0 0 1px ${v.color}33`,
      }}
    >
      {v.mono}
    </span>
  );
}
