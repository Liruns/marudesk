import { app } from 'electron';
import {
  MARUDESK_GITHUB_URL,
  MARUDESK_RELEASES_URL,
  type AppInfo,
  type UpdateCheckResult,
  type UpdateCheckUnavailableReason,
} from '../shared/app-info';
import { defineHandler } from './ipc/define-handler';
import { openExternalUrl } from './safe-open';

const LATEST_RELEASE_API_URL =
  'https://api.github.com/repos/Liruns/marudesk/releases/latest';
const UPDATE_CHECK_TIMEOUT_MS = 10_000;

type LatestRelease = {
  readonly tagName: string;
  readonly releaseUrl: string;
  readonly releaseName?: string;
};

function appInfo(): AppInfo {
  return {
    name: 'marudesk',
    version: app.getVersion(),
    githubUrl: MARUDESK_GITHUB_URL,
    releasesUrl: MARUDESK_RELEASES_URL,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeReleaseUrl(url: string): string {
  const releasePrefix = `${MARUDESK_RELEASES_URL}/`;
  return url === MARUDESK_RELEASES_URL || url.startsWith(releasePrefix)
    ? url
    : MARUDESK_RELEASES_URL;
}

function parseLatestRelease(payload: unknown): LatestRelease | null {
  if (!isRecord(payload)) return null;
  const tagName = payload['tag_name'];
  const releaseUrl = payload['html_url'];
  const releaseName = payload['name'];
  if (typeof tagName !== 'string' || typeof releaseUrl !== 'string') {
    return null;
  }
  const trimmedName = typeof releaseName === 'string' ? releaseName.trim() : '';
  if (trimmedName.length === 0) {
    return { tagName, releaseUrl: safeReleaseUrl(releaseUrl) };
  }
  return {
    tagName,
    releaseUrl: safeReleaseUrl(releaseUrl),
    releaseName: trimmedName,
  };
}

function parseVersion(version: string): readonly number[] | null {
  const core = version.trim().replace(/^v/i, '').split(/[+-]/, 1)[0] ?? '';
  if (core.length === 0) return null;
  const parsed = core.split('.').map((part) => Number.parseInt(part, 10));
  if (parsed.some((part) => !Number.isFinite(part) || part < 0)) return null;
  return parsed;
}

function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const base = parseVersion(current);
  if (!next || !base) return candidate !== current;
  const length = Math.max(next.length, base.length);
  for (let index = 0; index < length; index += 1) {
    const nextPart = next[index] ?? 0;
    const basePart = base[index] ?? 0;
    if (nextPart > basePart) return true;
    if (nextPart < basePart) return false;
  }
  return false;
}

function unavailable(reason: UpdateCheckUnavailableReason): UpdateCheckResult {
  return {
    kind: 'unavailable',
    currentVersion: app.getVersion(),
    reason,
    releaseUrl: MARUDESK_RELEASES_URL,
    checkedAt: Date.now(),
  };
}

async function checkForUpdates(): Promise<UpdateCheckResult> {
  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
  try {
    response = await fetch(LATEST_RELEASE_API_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'marudesk',
      },
    });
  } catch {
    return unavailable('network-error');
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 404) return unavailable('no-release');
  if (!response.ok) return unavailable('network-error');

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return unavailable('invalid-response');
  }
  const latest = parseLatestRelease(payload);
  if (!latest) return unavailable('invalid-response');

  const currentVersion = app.getVersion();
  const checkedAt = Date.now();
  if (isNewerVersion(latest.tagName, currentVersion)) {
    return latest.releaseName
      ? {
          kind: 'available',
          currentVersion,
          latestVersion: latest.tagName,
          releaseUrl: latest.releaseUrl,
          releaseName: latest.releaseName,
          checkedAt,
        }
      : {
          kind: 'available',
          currentVersion,
          latestVersion: latest.tagName,
          releaseUrl: latest.releaseUrl,
          checkedAt,
        };
  }

  return {
    kind: 'up-to-date',
    currentVersion,
    latestVersion: latest.tagName,
    releaseUrl: latest.releaseUrl,
    checkedAt,
  };
}

export function registerAppInfoHandlers(): void {
  defineHandler('app:info', () => appInfo());
  defineHandler('app:open-github', () => {
    openExternalUrl(MARUDESK_GITHUB_URL);
  });
  defineHandler('app:open-releases', () => {
    openExternalUrl(MARUDESK_RELEASES_URL);
  });
  defineHandler('app:check-for-updates', () => checkForUpdates());
}
