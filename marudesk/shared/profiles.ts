/**
 * App profiles (Chrome/VS Code-style). Each profile is an isolated data set —
 * settings, tabs, workspaces, sessions, history, DB — achieved by pointing
 * Electron's `userData` at a per-profile directory at boot. The default profile
 * keeps the original userData (no migration); others live under profiles/<id>.
 */

/** The cloud identity linked to a profile (set by the relay Google sign-in). */
export type ProfileLinkedAccount = {
  readonly provider: 'google';
  readonly email: string;
  readonly displayName?: string;
};

export type ProfileMeta = {
  readonly id: string;
  readonly name: string;
  /** Present when the profile is linked to a cloud account; cleared on logout. */
  readonly account?: ProfileLinkedAccount;
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

/** Parse a stored linked account; anything malformed degrades to "not linked". */
function sanitizeLinkedAccount(value: unknown): ProfileLinkedAccount | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const a = value as Record<string, unknown>;
  if (a.provider !== 'google' || typeof a.email !== 'string' || a.email.length === 0) {
    return undefined;
  }
  return {
    provider: 'google',
    email: a.email,
    ...(typeof a.displayName === 'string' && a.displayName ? { displayName: a.displayName } : {}),
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
      const account = sanitizeLinkedAccount(r.account);
      profiles.push({ id: r.id, name: r.name, ...(account ? { account } : {}) });
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

/**
 * The web tabs' Electron session partition for a profile. Profile-scoped because
 * Electron caches sessions by partition NAME for the process lifetime — after a
 * live profile switch, reusing one name would keep serving the PREVIOUS profile's
 * cookies/storage. The default profile keeps the legacy name so existing web
 * sign-ins survive the upgrade (its data already lives in the original userData).
 */
export function webTabPartitionForProfile(id: string): string {
  return id === DEFAULT_PROFILE_ID ? 'persist:inspect-target' : `persist:web-tabs-${id}`;
}
