import { app } from 'electron';
import path from 'node:path';
import { createRequire } from 'node:module';
import type DatabaseType from 'better-sqlite3';

/**
 * The app's local SQLite database (hybrid storage — docs/data-storage-design).
 * marudesk historically persisted everything as JSON files; high-volume,
 * queryable state (AI Chat sessions + their full-text search index) now lives
 * here instead, while settings/secrets/MCP config stay as JSON.
 *
 * better-sqlite3 is a native module (like node-pty): it's externalized from the
 * main bundle and loaded from node_modules at runtime via createRequire. If it
 * fails to load — most commonly an ABI mismatch when the binary wasn't rebuilt
 * for Electron (`npm run rebuild:native`) — we DON'T crash: `getDb()` returns
 * null and every caller falls back to its JSON path. So the feature degrades to
 * the prior behavior instead of taking the app down.
 */

const require = createRequire(import.meta.url);

type Db = DatabaseType.Database;

// Tri-state: undefined = not tried yet, null = unavailable (fell back to JSON),
// Db = open and migrated.
let db: Db | null | undefined;

function dbFile(): string {
  return path.join(app.getPath('userData'), 'marudesk.db');
}

/** Apply the schema. Idempotent — safe to run on every open. */
function migrate(conn: Db): void {
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  conn.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      createdAt    INTEGER NOT NULL,
      updatedAt    INTEGER NOT NULL,
      provider     TEXT NOT NULL,
      model        TEXT NOT NULL,
      messageCount INTEGER NOT NULL,
      record       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_updatedAt ON sessions(updatedAt DESC);

    -- Full-text index over title + flattened transcript body (hermes-agent-style
    -- session recall). A plain (non-contentless) fts5 table so rows can be
    -- deleted/replaced by the UNINDEXED id without external-content bookkeeping.
    CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
      id UNINDEXED,
      title,
      body
    );

    -- A second, trigram-tokenized index over the same text (hermes-agent ships
    -- both). The default tokenizer only matches whole words/prefixes; trigram
    -- matches arbitrary substrings (≥3 chars) and handles CJK / Hangul, so a
    -- search like "팩토" or "uthH" finds mid-word/mid-token hits the word index
    -- misses. searchSessions unions the two.
    CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts_trigram USING fts5(
      id UNINDEXED,
      title,
      body,
      tokenize = 'trigram'
    );
  `);
}

/**
 * The open database, or null when SQLite is unavailable (caller must fall back
 * to JSON). Opened lazily on first use and memoized; a load/open failure is
 * cached as null so we don't retry the broken require on every call.
 */
export function getDb(): Db | null {
  if (db !== undefined) return db;
  try {
    const Database = require('better-sqlite3') as typeof DatabaseType;
    const conn = new Database(dbFile());
    migrate(conn);
    db = conn;
  } catch (err) {
    // ABI mismatch (no electron-rebuild), missing module, or unwritable path.
    console.warn(
      '[db] SQLite unavailable — falling back to JSON storage:',
      err instanceof Error ? err.message : err,
    );
    db = null;
  }
  return db;
}

/** Whether SQLite is the active backend (vs. the JSON fallback). */
export function isDbAvailable(): boolean {
  return getDb() !== null;
}

/** Close the database on shutdown (best-effort). */
export function closeDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      // ignore — process is exiting
    }
  }
  db = undefined;
}
