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
