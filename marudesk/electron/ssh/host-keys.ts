import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SshPinnedHostKey } from '../../shared/ssh.ts';

/**
 * Trust-on-first-use SSH host key pinning (fixes the connection-manager's
 * SECURITY TODO). First connect to a host:port stores its key's algorithm +
 * SHA256 fingerprint; every later connect compares, and a mismatch REJECTS the
 * handshake — the MITM defense plain first-use acceptance lacked.
 *
 * This module is deliberately electron-free (the store file path is always a
 * parameter) so the headless harness (host-keys.harness.ts) can exercise the
 * full pin → match → mismatch → clear cycle under plain Node. The electron
 * glue that resolves the real userData path lives in ./host-keys-file.ts.
 *
 * On-disk format (JSON, one file): { version: 1, hosts: { "<host>:<port>":
 * { algorithm, fingerprintSha256, pinnedAt } } }. A corrupt or missing file
 * degrades to "nothing pinned" — i.e. back to first-sight pinning, never a
 * lockout.
 */

const STORE_VERSION = 1;

type StoredEntry = {
  algorithm: string;
  fingerprintSha256: string;
  pinnedAt: number;
};

type StoreShape = {
  version: number;
  hosts: Record<string, StoredEntry>;
};

/** Stable map key for a pinned host: `host:port`. */
export function hostKeyId(host: string, port: number): string {
  return `${host}:${port}`;
}

/**
 * Parse the algorithm name out of a raw SSH host key blob (RFC 4253 wire
 * format: uint32 length + ASCII algorithm name). Returns 'unknown' for a
 * malformed blob instead of throwing — the fingerprint still pins the key.
 */
export function parseHostKeyAlgorithm(key: Buffer): string {
  if (key.length < 4) return 'unknown';
  const len = key.readUInt32BE(0);
  if (len <= 0 || len > 64 || key.length < 4 + len) return 'unknown';
  const name = key.subarray(4, 4 + len).toString('ascii');
  return /^[\x21-\x7e]+$/.test(name) ? name : 'unknown';
}

/** OpenSSH-style fingerprint of a raw host key blob: `SHA256:<base64>` (no `=`). */
export function sha256Fingerprint(key: Buffer): string {
  const digest = crypto.createHash('sha256').update(key).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

export type HostKeyVerdict =
  | {
      ok: true;
      /** True when nothing was pinned yet — caller should pin now (TOFU). */
      firstSight: boolean;
      algorithm: string;
      fingerprintSha256: string;
    }
  | { ok: false; error: string };

/**
 * Pure TOFU decision: compare the offered key against the pinned record.
 *  - nothing pinned  → ok, firstSight (caller pins and proceeds)
 *  - same fingerprint → ok
 *  - different        → reject, with an error naming the host, both
 *                       fingerprints, and how to clear the pin.
 */
export function evaluateHostKey(
  pinned: SshPinnedHostKey | undefined,
  host: string,
  port: number,
  key: Buffer,
): HostKeyVerdict {
  const algorithm = parseHostKeyAlgorithm(key);
  const fingerprintSha256 = sha256Fingerprint(key);
  if (!pinned) return { ok: true, firstSight: true, algorithm, fingerprintSha256 };
  if (pinned.fingerprintSha256 === fingerprintSha256) {
    return { ok: true, firstSight: false, algorithm, fingerprintSha256 };
  }
  return {
    ok: false,
    error:
      `host key verification failed for ${host}:${port} — the host's key has CHANGED. ` +
      `Pinned ${pinned.algorithm} ${pinned.fingerprintSha256}, but the server offered ` +
      `${algorithm} ${fingerprintSha256}. This can mean a man-in-the-middle attack, or that ` +
      `the host was legitimately reinstalled. If the change is expected, remove the pinned ` +
      `key in Settings → Remote → Pinned SSH host keys and reconnect.`,
  };
}

/* ── persistence ────────────────────────────────────────────────────────── */

async function loadStore(file: string): Promise<StoreShape> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { version: STORE_VERSION, hosts: {} };
    const hostsRaw = (parsed as { hosts?: unknown }).hosts;
    const hosts: Record<string, StoredEntry> = {};
    if (hostsRaw && typeof hostsRaw === 'object' && !Array.isArray(hostsRaw)) {
      for (const [id, value] of Object.entries(hostsRaw as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue;
        const v = value as Record<string, unknown>;
        if (typeof v.algorithm !== 'string' || typeof v.fingerprintSha256 !== 'string') continue;
        hosts[id] = {
          algorithm: v.algorithm,
          fingerprintSha256: v.fingerprintSha256,
          pinnedAt: typeof v.pinnedAt === 'number' && Number.isFinite(v.pinnedAt) ? v.pinnedAt : 0,
        };
      }
    }
    return { version: STORE_VERSION, hosts };
  } catch {
    // Missing or corrupt → nothing pinned (back to first-sight pinning).
    return { version: STORE_VERSION, hosts: {} };
  }
}

/**
 * Serialize writes so two concurrent first-sight connects can't interleave a
 * read-modify-write and drop each other's pin.
 */
let writeChain: Promise<unknown> = Promise.resolve();

function enqueue<T>(run: () => Promise<T>): Promise<T> {
  const result = writeChain.then(run, run);
  writeChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function saveStore(file: string, store: StoreShape): Promise<void> {
  // Atomic write (tmp + rename) so a crash mid-write can't corrupt the pins.
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.marudesk-tmp-${crypto.randomUUID()}`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

function fromStored(id: string, entry: StoredEntry): SshPinnedHostKey {
  const sep = id.lastIndexOf(':');
  const host = sep > 0 ? id.slice(0, sep) : id;
  const port = sep > 0 ? Number(id.slice(sep + 1)) : 0;
  return {
    host,
    port: Number.isInteger(port) ? port : 0,
    algorithm: entry.algorithm,
    fingerprintSha256: entry.fingerprintSha256,
    pinnedAt: entry.pinnedAt,
  };
}

/** All pinned host keys, newest pin first (for the Settings list). */
export async function listPinnedHostKeys(file: string): Promise<SshPinnedHostKey[]> {
  const store = await loadStore(file);
  return Object.entries(store.hosts)
    .map(([id, entry]) => fromStored(id, entry))
    .sort((a, b) => b.pinnedAt - a.pinnedAt);
}

/** The pinned key for one host:port, or undefined when nothing is pinned. */
export async function getPinnedHostKey(
  file: string,
  host: string,
  port: number,
): Promise<SshPinnedHostKey | undefined> {
  const store = await loadStore(file);
  const entry = store.hosts[hostKeyId(host, port)];
  return entry ? fromStored(hostKeyId(host, port), entry) : undefined;
}

/** Pin (or re-pin) a host key. First-sight TOFU writes go through here. */
export function pinHostKey(file: string, entry: SshPinnedHostKey): Promise<void> {
  return enqueue(async () => {
    const store = await loadStore(file);
    store.hosts[hostKeyId(entry.host, entry.port)] = {
      algorithm: entry.algorithm,
      fingerprintSha256: entry.fingerprintSha256,
      pinnedAt: entry.pinnedAt,
    };
    await saveStore(file, store);
  });
}

/** Remove one pinned host key. Returns whether an entry existed. */
export function clearPinnedHostKey(file: string, host: string, port: number): Promise<boolean> {
  return enqueue(async () => {
    const store = await loadStore(file);
    const id = hostKeyId(host, port);
    if (!(id in store.hosts)) return false;
    delete store.hosts[id];
    await saveStore(file, store);
    return true;
  });
}
