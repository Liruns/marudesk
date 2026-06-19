import { app } from 'electron';
import path from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { atomicWriteFile } from './fs-safe';
import { defineHandler } from './ipc/define-handler';
import { obj, str } from './ipc/validate';
import {
  DEFAULT_PROFILE_ID,
  defaultProfilesState,
  sanitizeProfiles,
  type ProfileMeta,
  type ProfilesState,
} from '../shared/profiles';

/**
 * Profile registry + the boot-time userData redirect. The list lives in the REAL
 * userData root (captured before any redirect). Switching a profile rewrites the
 * active id; the actual swap is applied LIVE by the main process (no restart) —
 * see electron/main.ts `applyProfileSwitch`, which flushes + tears down the old
 * profile's runtime, repoints userData, re-inits, and reloads the renderer.
 * See shared/profiles.ts for the model.
 */

// The real userData root, captured at module load before app.setPath redirects it.
const ROOT = app.getPath('userData');

// The active profile id, kept in memory so per-profile concerns (e.g. the web
// tabs' session partition) can read it without disk I/O. Set at boot by
// resolveActiveProfileDir and updated by persistActiveProfile on a live switch
// (the switch persists the id FIRST, then tears down/re-mounts — so anything
// created during the re-mount already sees the new id).
let activeProfileId = DEFAULT_PROFILE_ID;

/** The active profile's id (in-memory mirror of profiles.json). */
export function getActiveProfileId(): string {
  return activeProfileId;
}

function profilesFile(): string {
  return path.join(ROOT, 'profiles.json');
}

/** The data dir for a profile. Default keeps the original userData (no migration);
 *  others live under profiles/<id>. */
export function profileDir(id: string): string {
  return id === DEFAULT_PROFILE_ID ? ROOT : path.join(ROOT, 'profiles', id);
}

function readSync(): ProfilesState {
  try {
    return sanitizeProfiles(JSON.parse(readFileSync(profilesFile(), 'utf8')));
  } catch {
    return defaultProfilesState();
  }
}

function writeSync(state: ProfilesState): void {
  try {
    writeFileSync(profilesFile(), JSON.stringify(state, null, 2));
  } catch {
    // ignore — a failed write must not block startup
  }
}

async function writeAtomic(state: ProfilesState): Promise<void> {
  await atomicWriteFile(profilesFile(), JSON.stringify(state, null, 2));
}

/**
 * Resolve the active profile's data dir, normalizing profiles.json and creating
 * the dir as needed. Called ONCE at startup, before app.setPath('userData', …).
 */
export function resolveActiveProfileDir(): string {
  const state = readSync();
  writeSync(state); // persist a normalized list on first run
  activeProfileId = state.activeProfileId;
  const dir = profileDir(state.activeProfileId);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ignore — a real failure surfaces later through normal file ops
  }
  return dir;
}

export function listProfiles(): ProfilesState {
  return readSync();
}

async function createProfile(name: string): Promise<ProfileMeta> {
  const meta: ProfileMeta = { id: randomUUID(), name: name.trim() || 'Profile' };
  const state = readSync();
  await writeAtomic({ ...state, profiles: [...state.profiles, meta] });
  try {
    mkdirSync(profileDir(meta.id), { recursive: true });
  } catch {
    // ignore
  }
  return meta;
}

async function renameProfile(id: string, name: string): Promise<ProfilesState> {
  const trimmed = name.trim();
  const state = readSync();
  if (!trimmed) return state;
  const next: ProfilesState = {
    ...state,
    profiles: state.profiles.map((p) => (p.id === id ? { ...p, name: trimmed } : p)),
  };
  await writeAtomic(next);
  return next;
}

async function deleteProfile(id: string): Promise<ProfilesState> {
  const state = readSync();
  // Never delete the default profile or the one currently in use.
  if (id === DEFAULT_PROFILE_ID || id === state.activeProfileId) return state;
  const next: ProfilesState = { ...state, profiles: state.profiles.filter((p) => p.id !== id) };
  await writeAtomic(next);
  try {
    rmSync(profileDir(id), { recursive: true, force: true });
  } catch {
    // ignore
  }
  return next;
}

/**
 * Persist a new active-profile id to the root profiles.json (no userData side
 * effects). Returns true when the active profile actually changed — the caller
 * (main's applyProfileSwitch) then performs the live runtime swap. Writing the id
 * first means a fallback hard-restart would still boot into the chosen profile.
 */
export async function persistActiveProfile(id: string): Promise<boolean> {
  const state = readSync();
  if (id === state.activeProfileId || !state.profiles.some((p) => p.id === id)) return false;
  await writeAtomic({ ...state, activeProfileId: id });
  activeProfileId = id;
  return true;
}

export function registerProfileHandlers(deps: {
  /** Apply a profile switch live (flush + teardown + repoint + reload). */
  applyProfileSwitch: (id: string) => Promise<void>;
}): void {
  defineHandler('profiles:list', () => listProfiles());
  defineHandler('profiles:create', ([name]) => createProfile(typeof name === 'string' ? name : ''));
  defineHandler('profiles:rename', ([payload]) => {
    const p = obj(payload);
    return renameProfile(str(p.id, 'id'), str(p.name, 'name'));
  });
  defineHandler('profiles:delete', ([id]) => deleteProfile(str(id, 'id')));
  defineHandler('profiles:switch', ([id]) => deps.applyProfileSwitch(str(id, 'id')));
}
