/**
 * App profiles (Chrome/VS Code-style). Each profile is an isolated data set —
 * settings, tabs, workspaces, sessions, history, DB — achieved by pointing
 * Electron's `userData` at a per-profile directory at boot. The default profile
 * keeps the original userData (no migration); others live under profiles/<id>.
 */

export type ProfileMeta = {
  readonly id: string;
  readonly name: string;
};

export type ProfilesState = {
  readonly activeProfileId: string;
  readonly profiles: ProfileMeta[];
};

export const DEFAULT_PROFILE_ID = 'default';
export const DEFAULT_PROFILE_NAME = 'Default';

export function defaultProfilesState(): ProfilesState {
  return {
    activeProfileId: DEFAULT_PROFILE_ID,
    profiles: [{ id: DEFAULT_PROFILE_ID, name: DEFAULT_PROFILE_NAME }],
  };
}

/** Coerce arbitrary JSON into a valid ProfilesState: dedupe, guarantee a default
 *  profile, and reset a dangling active id. */
export function sanitizeProfiles(parsed: unknown): ProfilesState {
  if (!parsed || typeof parsed !== 'object') return defaultProfilesState();
  const o = parsed as Record<string, unknown>;
  const seen = new Set<string>();
  const profiles: ProfileMeta[] = [];
  if (Array.isArray(o.profiles)) {
    for (const p of o.profiles) {
      if (!p || typeof p !== 'object') continue;
      const r = p as Record<string, unknown>;
      if (typeof r.id !== 'string' || typeof r.name !== 'string') continue;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      profiles.push({ id: r.id, name: r.name });
    }
  }
  if (!profiles.some((p) => p.id === DEFAULT_PROFILE_ID)) {
    profiles.unshift({ id: DEFAULT_PROFILE_ID, name: DEFAULT_PROFILE_NAME });
  }
  const activeProfileId =
    typeof o.activeProfileId === 'string' && profiles.some((p) => p.id === o.activeProfileId)
      ? o.activeProfileId
      : DEFAULT_PROFILE_ID;
  return { activeProfileId, profiles };
}
