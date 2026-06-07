import { app } from 'electron';
import { resolveActiveProfileDir } from './profile-store';

/**
 * Point Electron's `userData` at the active profile's directory BEFORE any other
 * module reads it, so settings / tabs / workspaces / sessions / history / the
 * SQLite DB all live per-profile. This module is imported first in main.ts; its
 * single side effect runs at import time (the persistence modules only touch
 * userData lazily, at first use, which is always after this). The default profile
 * keeps the original userData, so existing installs need no migration.
 */
app.setPath('userData', resolveActiveProfileDir());
