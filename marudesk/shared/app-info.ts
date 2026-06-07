export const MARUDESK_GITHUB_URL = 'https://github.com/Liruns/marudesk';
export const MARUDESK_RELEASES_URL = `${MARUDESK_GITHUB_URL}/releases`;

export type AppInfo = {
  readonly name: 'marudesk';
  readonly version: string;
  readonly githubUrl: string;
  readonly releasesUrl: string;
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
