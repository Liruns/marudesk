import { app } from 'electron';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * The app's local SQLite database (hybrid storage — docs/data-storage-design).
 * marudesk historically persisted everything as JSON files; high-volume,
 * queryable state (AI Chat sessions + their full-text search index) now lives
 * here instead, while settings/secrets/MCP config stay as JSON.
 *
 * Backed by Node's built-in `node:sqlite` (DatabaseSync), NOT a native addon:
 * the SQLite engine — FTS5 with the trigram tokenizer included — ships inside
 * Node/Electron itself, so there's nothing to compile or rebuild per Electron
 * version (the previous better-sqlite3 backend needed `npm run rebuild:native`
 * and couldn't build against Electron's newer V8). If `node:sqlite` is somehow
 * unavailable we DON'T crash: `getDb()` returns null and every caller falls back
 * to its JSON path, so the feature degrades to the prior behavior.
 */

const require = createRequire(import.meta.url);

/** Prepared-statement surface our callers use (better-sqlite3-compatible). */
interface Stmt {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** Connection surface our callers use (better-sqlite3-compatible subset). */
export interface Db {
  prepare(sql: string): Stmt;
  exec(sql: string): void;
  pragma(pragma: string): void;
  transaction<T>(fn: (arg: T) => void): (arg: T) => void;
  close(): void;
}

/** The slice of node:sqlite's DatabaseSync we rely on. */
interface DatabaseSyncLike {
  prepare(sql: string): Stmt;
  exec(sql: string): void;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (filename: string) => DatabaseSyncLike;
}

// Tri-state: undefined = not tried yet, null = unavailable (fell back to JSON),
// Db = open and migrated.
let db: Db | null | undefined;

function dbFile(): string {
  return path.join(app.getPath('userData'), 'marudesk.db');
}

/**
 * Adapt a node:sqlite connection to the better-sqlite3-shaped {@link Db} our
 * callers were written against. node:sqlite lacks better-sqlite3's `pragma()`
 * and `transaction()` helpers, so we synthesize them from plain statements.
 */
function wrap(conn: DatabaseSyncLike): Db {
  return {
    prepare: (sql) => conn.prepare(sql),
    exec: (sql) => conn.exec(sql),
    // PRAGMA is just a statement in node:sqlite.
    pragma: (pragma) => conn.exec(`PRAGMA ${pragma}`),
    // Emulate better-sqlite3's transaction(fn) → callable wrapper.
    transaction:
      <T>(fn: (arg: T) => void) =>
      (arg: T) => {
        conn.exec('BEGIN');
        try {
          fn(arg);
          conn.exec('COMMIT');
        } catch (err) {
          try {
            conn.exec('ROLLBACK');
          } catch {
            // ignore — surface the original error
          }
          throw err;
        }
      },
    close: () => conn.close(),
  };
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
    const { DatabaseSync } = require('node:sqlite') as SqliteModule;
    const conn = wrap(new DatabaseSync(dbFile()));
    migrate(conn);
    db = conn;
  } catch (err) {
    // node:sqlite disabled/absent, or an unwritable path.
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
