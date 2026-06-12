import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

/**
 * On-demand installer for the cloudflared binary the auto tunnel spawns
 * (./tunnel.ts). When the user flips Auto tunnel on and cloudflared isn't on
 * PATH, this downloads a PINNED release straight from Cloudflare's official
 * GitHub repo, verifies its SHA-256 against hashes recorded here, and installs
 * it under the app's user-data dir — so enabling the toggle is the only step.
 *
 * Supply-chain posture: the version is pinned (no "latest"), the per-asset
 * digests below were computed from the published release assets, and a
 * mismatching download is discarded. Upgrades happen by bumping the pin +
 * hashes in a reviewed commit, never silently at runtime.
 */

export const CLOUDFLARED_VERSION = '2026.6.0';

/** SHA-256 of each pinned release asset (sha256sum over the raw download). */
const ASSET_SHA256: Record<string, string> = {
  'cloudflared-linux-amd64': '08d27c4c5d3ed73ee3e98ef2ddceb4ad09fd4cfc28e243565a189538e8ccd706',
  'cloudflared-linux-arm64': '8482ebf1e74a2a4a1a9f1e090e17e3de08423f94100ece6789287cb26fb9480f',
  'cloudflared-windows-amd64.exe':
    '03e322598e84d77406fa55b93f59e8e54636c5d8501d9dce36697fcf080ed8cc',
  'cloudflared-darwin-amd64.tgz':
    'f6eaa91260ee327994331ac5ac2f7cec7925c4b6e15296b63fe0916992a06bdc',
  'cloudflared-darwin-arm64.tgz':
    '88e17987423d3fd49167305f8bda14d83a80ab9f2097ff9c82b317a39e342119',
};

/**
 * The release asset for a platform/arch, or null when unsupported. Pure —
 * unit-tested in pair-harness.ts.
 */
export function assetFor(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === 'linux' && arch === 'x64') return 'cloudflared-linux-amd64';
  if (platform === 'linux' && arch === 'arm64') return 'cloudflared-linux-arm64';
  if (platform === 'win32' && arch === 'x64') return 'cloudflared-windows-amd64.exe';
  if (platform === 'darwin' && arch === 'x64') return 'cloudflared-darwin-amd64.tgz';
  if (platform === 'darwin' && arch === 'arm64') return 'cloudflared-darwin-arm64.tgz';
  return null;
}

/** Where the managed binary lives under the app's user-data dir. */
export function managedBinaryPath(userDataDir: string, platform: NodeJS.Platform): string {
  return join(userDataDir, 'bin', platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
}

/**
 * Extract one file's bytes from an uncompressed tar archive (the macOS release
 * is a single-entry tgz). Minimal POSIX-tar walk: 512-byte headers, octal size,
 * data padded to 512. Returns null when no entry's basename matches. Pure —
 * unit-tested in pair-harness.ts.
 */
export function extractTarEntry(tar: Buffer, basename: string): Buffer | null {
  let off = 0;
  while (off + 512 <= tar.length) {
    const name = tar.subarray(off, off + 100).toString('utf8').replace(/\0.*$/, '');
    if (name.length === 0) break; // the end-of-archive zero blocks
    const size = Number.parseInt(tar.subarray(off + 124, off + 136).toString('utf8').trim(), 8);
    if (!Number.isFinite(size) || size < 0) return null;
    const type = tar[off + 156];
    const dataStart = off + 512;
    // '0' or NUL = regular file; match on the path's basename ("./cloudflared" too).
    if ((type === 0x30 || type === 0) && name.split('/').pop() === basename) {
      return tar.subarray(dataStart, dataStart + size);
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** HTTPS GET into memory, following same-https redirects (GitHub → object store). */
function download(url: string, redirectsLeft = 5): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const { statusCode = 0, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (redirectsLeft === 0) {
          reject(new Error('too many redirects'));
          return;
        }
        if (!headers.location.startsWith('https://')) {
          reject(new Error('refusing a non-https redirect'));
          return;
        }
        resolve(download(headers.location, redirectsLeft - 1));
        return;
      }
      if (statusCode !== 200) {
        res.resume();
        reject(new Error(`download failed (HTTP ${statusCode})`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120_000, () => req.destroy(new Error('download timed out')));
  });
}

/** One install at a time — concurrent enables await the same attempt. */
let inflight: Promise<string> | null = null;

/**
 * Ensure the managed cloudflared binary exists under `userDataDir`, downloading
 * + verifying the pinned release if needed. Resolves with the binary path;
 * rejects with a human-readable error (unsupported platform, network failure,
 * digest mismatch).
 */
export function ensureCloudflared(
  userDataDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<string> {
  const target = managedBinaryPath(userDataDir, platform);
  if (existsSync(target)) return Promise.resolve(target);
  if (inflight) return inflight;
  inflight = installCloudflared(userDataDir, platform, arch, target).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function installCloudflared(
  userDataDir: string,
  platform: NodeJS.Platform,
  arch: string,
  target: string,
): Promise<string> {
  const asset = assetFor(platform, arch);
  if (!asset) {
    throw new Error(`no cloudflared build for ${platform}/${arch} — set a Public URL instead`);
  }
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset}`;
  const raw = await download(url);

  const digest = createHash('sha256').update(raw).digest('hex');
  if (digest !== ASSET_SHA256[asset]) {
    throw new Error(`cloudflared download failed integrity check (${asset})`);
  }

  let binary: Buffer;
  if (asset.endsWith('.tgz')) {
    const entry = extractTarEntry(gunzipSync(raw), 'cloudflared');
    if (!entry) throw new Error('cloudflared archive had no binary entry');
    binary = entry;
  } else {
    binary = raw;
  }

  mkdirSync(join(userDataDir, 'bin'), { recursive: true });
  // Write-then-rename so a crash mid-write never leaves a half binary in place.
  const tmp = `${target}.download`;
  try {
    writeFileSync(tmp, binary, { mode: 0o755 });
    chmodSync(tmp, 0o755);
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return target;
}
