import { scrubText } from '../../../shared/scrub';
import { getMessage, parseLocale, type Locale, type TranslationKey } from '../../i18n/messages';
import type { DevtoolsState, DockSide, RenderingState } from './store';

/**
 * Small internal constants/helpers shared between the devtools store and the
 * extracted reducers/slices (ingest-batch.ts, slice-elements.ts). Kept in their
 * own module so those don't have to import back from store.ts (which would
 * create a value-level import cycle).
 */

function currentLocale(): Locale {
  try {
    return parseLocale(localStorage.getItem('marudesk.locale')) ?? 'en';
  } catch {
    return 'en';
  }
}

/** Resolve a translation key in the user's current locale. */
export function msg(key: TranslationKey): string {
  return getMessage(currentLocale(), key);
}

export const MAX_CONSOLE = 1500;
export const MAX_HISTORY = 200;
export const MAX_NETWORK = 1500;
const MAX_NETWORK_PAYLOAD = 64_000;

/**
 * Scrub a captured request/response body and bound it to {@link MAX_NETWORK_PAYLOAD},
 * flagging when it was truncated. Returns null when there's no value to store.
 */
export function boundedNetworkPayload(value: string | undefined): {
  text: string;
  truncated: boolean;
} | null {
  if (value === undefined) return null;
  const scrubbed = scrubText(value);
  if (scrubbed.length <= MAX_NETWORK_PAYLOAD) {
    return { text: scrubbed, truncated: false };
  }
  return {
    text: scrubbed.slice(0, MAX_NETWORK_PAYLOAD),
    truncated: true,
  };
}

let entrySeq = 0;
/** Monotonic id for console/network entries within a session. */
export function entryId(): string {
  return `c${++entrySeq}`;
}

/** Dock size defaults/min (px) — the right rail is wider than the bottom drawer. */
export const DEFAULT_SIZE: Record<DockSide, number> = { right: 480, bottom: 320 };
export const MIN_SIZE = 220;

// CDP overlay box-model colours (content / padding / border / margin).
const rgba = (r: number, g: number, b: number, a: number) => ({ r, g, b, a });
export const HIGHLIGHT_CONFIG = {
  showInfo: true,
  showStyles: false,
  contentColor: rgba(111, 168, 220, 0.45),
  paddingColor: rgba(147, 196, 125, 0.55),
  borderColor: rgba(255, 229, 153, 0.65),
  marginColor: rgba(246, 178, 107, 0.55),
};

/** Initial values for every per-page CDP slice — reset on (re)attach/navigation. */
export function freshSlices(): Pick<
  DevtoolsState,
  | 'nodes'
  | 'childIds'
  | 'documentId'
  | 'selectedId'
  | 'expanded'
  | 'styles'
  | 'stylesLoading'
  | 'picking'
  | 'forcedStates'
  | 'boxModel'
  | 'searchId'
  | 'searchResults'
  | 'searchIndex'
  | 'searchCount'
  | 'styleSheets'
  | 'pendingPatch'
  | 'console'
  | 'network'
  | 'appOrigin'
  | 'localStorageItems'
  | 'sessionStorageItems'
  | 'cookies'
  | 'appLoading'
  | 'dropped'
  | 'navStartTime'
  | 'domContentTime'
  | 'loadTime'
> {
  return {
    nodes: new Map(),
    childIds: new Map(),
    documentId: null,
    selectedId: null,
    expanded: new Set(),
    styles: null,
    stylesLoading: false,
    picking: false,
    forcedStates: new Set(),
    boxModel: null,
    searchId: null,
    searchResults: [],
    searchIndex: 0,
    searchCount: 0,
    styleSheets: new Map(),
    pendingPatch: null,
    console: [],
    network: [],
    appOrigin: null,
    localStorageItems: [],
    sessionStorageItems: [],
    cookies: [],
    appLoading: false,
    dropped: 0,
    navStartTime: null,
    domContentTime: null,
    loadTime: null,
  };
}

/** True if any rendering override is active (so it's worth re-applying on attach). */
export function hasRenderingOverrides(r: RenderingState): boolean {
  return (
    r.paintRects ||
    r.layoutShiftRegions ||
    r.fpsCounter ||
    r.scrollBottleneck ||
    r.webVitals ||
    r.colorScheme !== 'no-override' ||
    r.reducedMotion ||
    r.printMedia ||
    r.visionDeficiency !== 'none'
  );
}
