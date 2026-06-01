import { b64urlToBytes, importAesKey, type SessionKey } from '../../shared/e2e';
import type { PairedDeviceInfo } from '../../shared/remote';
import { getPairedDevicesStored, setPairedDevicesStored, type StoredDevice } from '../secrets';

/**
 * The PC's paired-device registry for the direct LAN/Tailscale bridge
 * (docs/t2-secure-pairing-design.md §2). Owns the in-memory list (loaded from
 * safeStorage at startup), caches the imported AES session key per device, and
 * exposes two faces:
 *   - a router-facing {@link DeviceResolver} — `getKey` / `touch` — for the E2E
 *     envelope auth (possession of the key IS the device's authentication);
 *   - management ops for the Settings UI — list (sanitized) / revoke.
 *
 * The session key is a bearer-equivalent secret, so it never crosses IPC: only the
 * sanitized {@link PairedDeviceInfo} does. Revoking drops the key, after which the
 * device's envelopes can no longer be opened.
 */

/** The minimal device-key lookup the router needs for the encrypted path. */
export type DeviceResolver = {
  /** The device's AES session key, or null if it isn't (or is no longer) paired. */
  getKey(deviceId: string): Promise<SessionKey | null>;
  /** Note that the device just made a request (updates lastSeenAt; throttled). */
  touch(deviceId: string): void;
};

let devices: StoredDevice[] = [];
const keyCache = new Map<string, SessionKey>();
let loaded = false;

/** Load persisted devices into memory once (called at startup). */
export async function loadDevices(): Promise<void> {
  devices = await getPairedDevicesStored();
  keyCache.clear();
  loaded = true;
}

async function ensureLoaded(): Promise<void> {
  if (!loaded) await loadDevices();
}

/** Resolve a device's AES session key (imported once, then cached), or null. */
export async function getDeviceKey(deviceId: string): Promise<SessionKey | null> {
  await ensureLoaded();
  const cached = keyCache.get(deviceId);
  if (cached) return cached;
  const rec = devices.find((d) => d.deviceId === deviceId);
  if (!rec) return null;
  const key = await importAesKey(b64urlToBytes(rec.key));
  keyCache.set(deviceId, key);
  return key;
}

/**
 * Record that a device just connected. Updates lastSeenAt in memory immediately but
 * persists at most once a minute per device — a request-rate disk write (encrypting
 * the whole list each time) would be wasteful, and a missed lastSeenAt is harmless.
 */
export function touchDevice(deviceId: string): void {
  const rec = devices.find((d) => d.deviceId === deviceId);
  if (!rec) return;
  const now = Date.now();
  const prev = rec.lastSeenAt ? Date.parse(rec.lastSeenAt) : 0;
  rec.lastSeenAt = new Date(now).toISOString();
  if (Number.isFinite(prev) && now - prev < 60_000) return;
  void setPairedDevicesStored(devices).catch(() => {});
}

/** Add (or replace) a freshly-paired device: persist it + drop any stale cached key. */
export async function addDevice(rec: StoredDevice): Promise<void> {
  await ensureLoaded();
  devices = [...devices.filter((d) => d.deviceId !== rec.deviceId), rec];
  keyCache.delete(rec.deviceId);
  await setPairedDevicesStored(devices);
}

/** The sanitized device list for the Settings UI (never the keys). */
export async function listDeviceInfos(): Promise<PairedDeviceInfo[]> {
  await ensureLoaded();
  return devices.map((d) => ({
    deviceId: d.deviceId,
    name: d.name,
    fingerprint: d.fingerprint,
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
  }));
}

/** Revoke a device — drop its key (envelopes stop opening) + persist. Returns the new list. */
export async function revokeDevice(deviceId: string): Promise<PairedDeviceInfo[]> {
  await ensureLoaded();
  devices = devices.filter((d) => d.deviceId !== deviceId);
  keyCache.delete(deviceId);
  await setPairedDevicesStored(devices);
  return listDeviceInfos();
}

/** The router-facing resolver singleton (read-only key lookup + touch). */
export const deviceResolver: DeviceResolver = { getKey: getDeviceKey, touch: touchDevice };
