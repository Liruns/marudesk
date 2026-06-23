export const MARUDESK_GITHUB_URL = 'https://github.com/Liruns/marudesk';
export const MARUDESK_RELEASES_URL = `${MARUDESK_GITHUB_URL}/releases`;

export type AppInfo = {
  readonly name: 'marudesk';
  readonly version: string;
  readonly githubUrl: string;
  readonly releasesUrl: string;
};

/**
 * Localized labels for the close-to-tray context menu, which is built in the
 * main process (no i18n access). The renderer pushes them on mount + locale
 * change (`app:set-tray-labels`); main caches them with English fallbacks and
 * rebuilds the tray menu when they arrive. Same single-source-of-truth pattern
 * as the web-tab context menu's WebContextMenuLabels.
 */
export type TrayLabels = {
  readonly open: string;
  readonly quit: string;
};

export type UpdateCheckUnavailableReason =
  | 'network-error'
  | 'no-release'
  | 'invalid-response';

export type UpdateCheckResult =
  | {
      readonly kind: 'available';
      readonly currentVersion: string;
      readonly latestVersion: string;
      readonly releaseUrl: string;
      readonly releaseName?: string;
      readonly checkedAt: number;
    }
  | {
      readonly kind: 'up-to-date';
      readonly currentVersion: string;
      readonly latestVersion: string;
      readonly releaseUrl: string;
      readonly checkedAt: number;
    }
  | {
      readonly kind: 'unavailable';
      readonly currentVersion: string;
      readonly reason: UpdateCheckUnavailableReason;
      readonly releaseUrl: string;
      readonly checkedAt: number;
    };

/**
 * Live state of the in-app automatic updater (electron-updater, Windows only —
 * see electron/updater.ts). Distinct from {@link UpdateCheckResult}, which is the
 * manual GitHub-API check that opens the browser. This status drives the
 * download-progress + "restart to install" affordance and is pushed to the
 * renderer over the `app:update-status` event (and pulled once on mount via
 * `app:update-status` invoke). On platforms where the auto-updater does not run
 * (dev, non-Windows) it stays `disabled`.
 */
export type UpdateStatus =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'not-available' }
  | { readonly kind: 'available'; readonly version: string }
  | {
      readonly kind: 'downloading';
      readonly version: string;
      readonly percent: number;
    }
  | { readonly kind: 'downloaded'; readonly version: string }
  | { readonly kind: 'error'; readonly message: string };
