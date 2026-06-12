import type {
  ChangeEvent,
  FocusEvent,
  FormEvent,
  KeyboardEvent,
  RefObject,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookMarked,
  Download,
  Globe,
  Lock,
  MousePointerClick,
  RotateCw,
  Star,
  Volume2,
  VolumeX,
  Wrench,
  X,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { BrowserHistoryMenu, BrowserMenu } from './BrowserMenu';
import { findBookmark, useBookmarksStore } from './bookmarks';
import { useBrowserStrings } from './browserStrings';
import type { NavState } from '../../../shared/browser';

type Props = {
  readonly pendingUrl: string;
  readonly currentUrl: string;
  readonly inspectMode: boolean;
  readonly nav: NavState;
  readonly addressInputRef: RefObject<HTMLInputElement | null>;
  readonly downloadCount: number;
  readonly downloadsActive: boolean;
  readonly shelfOpen: boolean;
  readonly consoleErrorCount: number;
  readonly devtoolsOpen: boolean;
  readonly onAddressChange: (event: ChangeEvent<HTMLInputElement>) => void;
  // Address-bar suggestions: arrows/Enter/Esc go to the dropdown first, and a
  // blur (after the mousedown-accept window) dismisses it (BrowserCanvas).
  readonly onAddressKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly onAddressBlur: (event: FocusEvent<HTMLInputElement>) => void;
  readonly onSubmit: (event: FormEvent) => void;
  readonly onGoBack: () => void;
  readonly onGoForward: () => void;
  readonly onReloadOrStop: () => void;
  readonly onZoomReset: () => void;
  readonly onToggleAudio: () => void;
  readonly onToggleShelf: () => void;
  readonly onToggleInspect: () => void;
  readonly onToggleDevtools: () => void;
};

export function BrowserToolbar({
  pendingUrl,
  currentUrl,
  inspectMode,
  nav,
  addressInputRef,
  downloadCount,
  downloadsActive,
  shelfOpen,
  consoleErrorCount,
  devtoolsOpen,
  onAddressChange,
  onAddressKeyDown,
  onAddressBlur,
  onSubmit,
  onGoBack,
  onGoForward,
  onReloadOrStop,
  onZoomReset,
  onToggleAudio,
  onToggleShelf,
  onToggleInspect,
  onToggleDevtools,
}: Props) {
  const { t, formatDevtoolsToggleLabel, formatSchemeTitle, formatZoomResetAria } =
    useBrowserStrings();
  const hasUrl = currentUrl.length > 0 || nav.url.length > 0;
  const zoomPercent = Math.round(nav.zoomFactor * 100);

  return (
    <div className="shrink-0 px-3 py-1.5 flex items-center gap-1.5 bg-surface-2 border-b border-subtle relative">
      <NavIconButton
        label={t('browser.nav.back')}
        disabled={!nav.canGoBack}
        onClick={onGoBack}
      >
        <ArrowLeft size={16} />
      </NavIconButton>
      <NavIconButton
        label={t('browser.nav.forward')}
        disabled={!nav.canGoForward}
        onClick={onGoForward}
      >
        <ArrowRight size={16} />
      </NavIconButton>
      <NavIconButton
        label={t(nav.isLoading ? 'browser.nav.stop' : 'browser.nav.reload')}
        disabled={!hasUrl}
        onClick={onReloadOrStop}
      >
        {nav.isLoading ? <X size={16} /> : <RotateCw size={16} />}
      </NavIconButton>

      <form onSubmit={onSubmit} className="flex-1 min-w-0" role="search">
        <div
          className={cn(
            'h-8 w-full rounded-pill bg-surface-page border flex items-center pl-3 pr-2 gap-2',
            'border-default focus-within:border-accent',
            'focus-within:ring-2 focus-within:ring-accent/25',
            'transition-colors duration-fast',
          )}
        >
          <SchemeIndicator
            url={nav.url || currentUrl}
            isSecure={nav.isSecure}
            secureTitle={formatSchemeTitle(true)}
            insecureTitle={formatSchemeTitle(false)}
            secureLabel={t('browser.security.secure.aria')}
            insecureLabel={t('browser.security.insecure.aria')}
          />
          <input
            ref={addressInputRef}
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('browser.address.placeholder')}
            value={pendingUrl}
            onChange={onAddressChange}
            onKeyDown={onAddressKeyDown}
            onBlur={onAddressBlur}
            onFocus={(e) => e.currentTarget.select()}
            className={cn(
              'flex-1 min-w-0 bg-transparent text-body-sm text-fg-primary',
              'placeholder:text-fg-tertiary focus:outline-none',
            )}
            aria-label={t('browser.address.aria')}
          />
          {nav.isLoading ? (
            <span
              aria-hidden
              className="size-2 rounded-pill bg-accent animate-pulse"
            />
          ) : null}
        </div>
      </form>

      <BookmarkStarButton nav={nav} currentUrl={currentUrl} />

      {nav.zoomFactor !== 1 ? (
        <button
          type="button"
          onClick={onZoomReset}
          title={t('browser.zoom.resetTitle')}
          aria-label={formatZoomResetAria(zoomPercent)}
          className={cn(
            'h-7 px-2 rounded-pill shrink-0 text-caption tabular-nums',
            'text-fg-secondary hover:bg-surface-3 hover:text-fg-primary',
            'transition-colors duration-fast',
          )}
        >
          {zoomPercent}%
        </button>
      ) : null}

      <BrowserHistoryMenu />

      <LibraryToggleButton />

      {nav.audible || nav.audioMuted ? (
        <NavIconButton
          label={t(nav.audioMuted ? 'browser.audio.unmute' : 'browser.audio.mute')}
          active={nav.audioMuted}
          aria-pressed={nav.audioMuted}
          onClick={onToggleAudio}
        >
          {nav.audioMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </NavIconButton>
      ) : null}

      {downloadCount > 0 ? (
        <NavIconButton
          label={t(shelfOpen ? 'browser.downloads.hide' : 'browser.downloads.show')}
          active={shelfOpen}
          aria-pressed={shelfOpen}
          onClick={onToggleShelf}
        >
          <span className="relative inline-flex">
            <Download size={16} />
            {downloadsActive ? (
              <span className="absolute -top-1 -right-1 size-1.5 rounded-pill bg-accent animate-pulse" />
            ) : null}
          </span>
        </NavIconButton>
      ) : null}

      <NavIconButton
        label={t(inspectMode ? 'browser.inspect.exit' : 'browser.inspect.enter')}
        active={inspectMode}
        onClick={onToggleInspect}
        aria-pressed={inspectMode}
      >
        <MousePointerClick size={16} />
      </NavIconButton>

      <NavIconButton
        label={formatDevtoolsToggleLabel(consoleErrorCount)}
        active={devtoolsOpen}
        aria-pressed={devtoolsOpen}
        onClick={onToggleDevtools}
      >
        <span className="relative inline-flex">
          <Wrench size={16} />
          {consoleErrorCount > 0 ? (
            <span className="absolute -top-1.5 -right-1.5 min-w-3.5 h-3.5 px-0.5 rounded-pill bg-error text-white text-[9px] leading-[14px] font-medium text-center tabular-nums">
              {consoleErrorCount > 9 ? '9+' : consoleErrorCount}
            </span>
          ) : null}
        </span>
      </NavIconButton>

      <BrowserMenu />

      {nav.isLoading ? (
        <span
          aria-hidden
          className="absolute left-0 right-0 bottom-0 h-px overflow-hidden"
        >
          <span
            className="absolute inset-y-0 left-0 w-1/3 bg-accent"
            style={{ animation: 'marudesk-loading 1.2s linear infinite' }}
          />
        </span>
      ) : null}
    </div>
  );
}

/**
 * The address-bar star: outline when the current page isn't bookmarked,
 * accent-filled when it is. Toggles the bookmark for the active tab's URL,
 * carrying the tab's live title + inlined favicon into the entry.
 */
function BookmarkStarButton({
  nav,
  currentUrl,
}: {
  nav: NavState;
  currentUrl: string;
}) {
  const { t } = useBrowserStrings();
  const bookmarks = useBookmarksStore((s) => s.bookmarks);
  const toggleBookmark = useBookmarksStore((s) => s.toggleBookmark);
  const pageUrl = nav.url || currentUrl;
  const bookmarked = !!findBookmark(bookmarks, pageUrl);

  return (
    <NavIconButton
      label={t(bookmarked ? 'browser.bookmarks.remove' : 'browser.bookmarks.add')}
      disabled={!pageUrl}
      active={bookmarked}
      aria-pressed={bookmarked}
      onClick={() =>
        void toggleBookmark({
          url: pageUrl,
          title: nav.title,
          faviconUrl: nav.favicon || undefined,
        })
      }
    >
      <Star size={16} fill={bookmarked ? 'currentColor' : 'none'} />
    </NavIconButton>
  );
}

/** Opens/closes the library panel (Bookmarks | History) beside the stage. */
function LibraryToggleButton() {
  const { t } = useBrowserStrings();
  const libraryOpen = useBookmarksStore((s) => s.libraryOpen);
  const toggleLibrary = useBookmarksStore((s) => s.toggleLibrary);

  return (
    <NavIconButton
      label={t('browser.library.button')}
      active={libraryOpen}
      aria-pressed={libraryOpen}
      onClick={toggleLibrary}
    >
      <BookMarked size={16} />
    </NavIconButton>
  );
}

function NavIconButton({
  label,
  disabled = false,
  active = false,
  onClick,
  children,
  ...rest
}: {
  label: string;
  disabled?: boolean;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'size-8 rounded-pill flex items-center justify-center shrink-0 transition-colors duration-fast',
        disabled
          ? 'text-fg-tertiary opacity-40 cursor-not-allowed'
          : active
            ? 'text-accent bg-accent-subtle/40 hover:bg-accent-subtle/60'
            : 'text-fg-secondary hover:bg-surface-3 hover:text-fg-primary',
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

function SchemeIndicator({
  url,
  isSecure,
  secureTitle,
  insecureTitle,
  secureLabel,
  insecureLabel,
}: {
  url: string;
  isSecure: boolean;
  secureTitle: string;
  insecureTitle: string;
  secureLabel: string;
  insecureLabel: string;
}) {
  if (!url) {
    return (
      <span className="text-fg-tertiary shrink-0" aria-hidden>
        <Globe size={14} />
      </span>
    );
  }
  if (isSecure) {
    return (
      <span
        className="text-fg-secondary shrink-0"
        aria-label={secureLabel}
        title={secureTitle}
      >
        <Lock size={14} />
      </span>
    );
  }
  return (
    <span
      className="text-warning shrink-0"
      aria-label={insecureLabel}
      title={insecureTitle}
    >
      <Globe size={14} />
    </span>
  );
}
