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
 * userData root (captured before any redirect); switching a profile rewrites the
 * active id and relaunches the app so every persistence module re-reads from the
 * new profile's directory. See shared/profiles.ts for the model.
 */

// The real userData root, captured at module load before app.setPath redirects it.
const ROOT = app.getPath('userData');

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

async function switchProfile(id: string): Promise<void> {
  const state = readSync();
  if (id === state.activeProfileId || !state.profiles.some((p) => p.id === id)) return;
  await writeAtomic({ ...state, activeProfileId: id });
  // Relaunch so every persistence module re-reads from the new profile dir.
  // quit() (not exit()) runs before-quit/closed handlers first, so the current
  // profile's tabs/workspaces/window state are saved before we restart.
  app.relaunch();
  app.quit();
}

export function registerProfileHandlers(): void {
  defineHandler('profiles:list', () => listProfiles());
  defineHandler('profiles:create', ([name]) => createProfile(typeof name === 'string' ? name : ''));
  defineHandler('profiles:rename', ([payload]) => {
    const p = obj(payload);
    return renameProfile(str(p.id, 'id'), str(p.name, 'name'));
  });
  defineHandler('profiles:delete', ([id]) => deleteProfile(str(id, 'id')));
  defineHandler('profiles:switch', ([id]) => switchProfile(str(id, 'id')));
}
