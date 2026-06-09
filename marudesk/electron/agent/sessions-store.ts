import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  SessionRecord,
  SessionSearchHit,
  SessionSummary,
  StorageStats,
} from '../../shared/context';
import { getDb } from '../db';

/**
 * Persistent store of previous AI Chat sessions (docs/context-mcp-design §4.1).
 * When a conversation ends (or is cleared for a new one) the loop snapshots the
 * transcript here so the agent's `list_sessions` / `read_session` context tools —
 * and the sessions UI — can recall it.
 *
 * Storage is hybrid (docs/data-storage-design): when SQLite is available the
 * records live in the `sessions` table with a `sessions_fts` full-text index for
 * search; otherwise we fall back to the original JSON layout under
 * userData/sessions/ (one `<id>.json` per record + an `index.json` of summaries).
 * Both paths are bounded to {@link MAX_SESSIONS} and best-effort — a failure
 * never breaks a turn. The exported API is backend-agnostic so the loop and the
 * IPC handlers don't care which one is active.
 */

const MAX_SESSIONS = 200;

/**
 * The full-text index tables kept in sync with `sessions` (see electron/db.ts):
 * the default word/prefix index and a trigram index for substring + CJK search.
 * Hardcoded literals — never interpolate anything user-controlled into SQL here.
 */
const FTS_TABLES = ['sessions_fts', 'sessions_fts_trigram'] as const;

function summaryOf(record: SessionRecord): SessionSummary {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    provider: record.provider,
    model: record.model,
    messageCount: record.messageCount,
  };
}

/** Flatten a record's transcript into plain text for the full-text index. */
function flattenBody(record: SessionRecord): string {
  const out: string[] = [record.title];
  for (const m of record.messages) {
    for (const p of m.parts) {
      if (p.type === 'text' || p.type === 'reasoning') out.push(p.text);
      else if (p.type === 'tool') {
        if (p.call.summary) out.push(p.call.summary);
        if (p.call.resultText) out.push(p.call.resultText);
      }
    }
  }
  return out.join('\n');
}

/* ── SQLite backend ─────────────────────────────────────────────────────── */

let migratedFromJson = false;

/**
 * Reset the one-time JSON→SQLite migration guard so the next session read
 * re-checks the now-active profile's (freshly opened) DB. Used by the live
 * profile switch after the DB handle is closed + repointed.
 */
export function resetSessionsStoreForProfile(): void {
  migratedFromJson = false;
}

/**
 * One-time import of any pre-existing JSON sessions into a freshly-created
 * SQLite store, so upgrading users keep their history. Runs once, only when the
 * `sessions` table is empty (a fresh DB) and JSON records exist on disk.
 */
async function migrateJsonIntoDb(db: ReturnType<typeof getDb>): Promise<void> {
  if (!db || migratedFromJson) return;
  migratedFromJson = true;
  try {
    const count = (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
    if (count > 0) return;
    const rows = await readIndexJson();
    for (const row of rows) {
      const record = await readSessionJson(row.id);
      if (record) dbUpsert(db, record);
    }
  } catch {
    // best-effort migration — never block on it
  }
}

function dbUpsert(db: NonNullable<ReturnType<typeof getDb>>, record: SessionRecord): void {
  const tx = db.transaction((rec: SessionRecord) => {
    db.prepare(
      `INSERT INTO sessions (id, title, createdAt, updatedAt, provider, model, messageCount, record)
       VALUES (@id, @title, @createdAt, @updatedAt, @provider, @model, @messageCount, @record)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title, updatedAt=excluded.updatedAt, provider=excluded.provider,
         model=excluded.model, messageCount=excluded.messageCount, record=excluded.record`,
    ).run({
      id: rec.id,
      title: rec.title,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      provider: rec.provider,
      model: rec.model,
      messageCount: rec.messageCount,
      record: JSON.stringify(rec),
    });
    const body = flattenBody(rec);
    for (const table of FTS_TABLES) {
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(rec.id);
      db.prepare(`INSERT INTO ${table} (id, title, body) VALUES (?, ?, ?)`).run(
        rec.id,
        rec.title,
        body,
      );
    }
    // Prune the oldest beyond the cap (and their fts rows).
    const stale = db
      .prepare(
        'SELECT id FROM sessions ORDER BY updatedAt DESC LIMIT -1 OFFSET ?',
      )
      .all(MAX_SESSIONS) as { id: string }[];
    for (const s of stale) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
      for (const table of FTS_TABLES) db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(s.id);
    }
  });
  tx(record);
}

/**
 * Turn a free-text query into a safe FTS5 MATCH expression: each whitespace
 * token becomes a quoted prefix term, AND-ed together. Quoting sidesteps FTS5
 * syntax errors on punctuation; the trailing `*` makes it prefix-match.
 */
function ftsQuery(query: string): string | null {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"*`);
  return tokens.length ? tokens.join(' ') : null;
}

/* ── JSON fallback backend ──────────────────────────────────────────────── */

function dir(): string {
  return path.join(app.getPath('userData'), 'sessions');
}
function indexPath(): string {
  return path.join(dir(), 'index.json');
}
function recordPath(id: string): string {
  // id is generated by the loop (uid('session-…')) — never user input — but pin
  // it to the directory anyway so a malformed id can't escape it.
  return path.join(dir(), `${path.basename(id)}.json`);
}

async function readIndexJson(): Promise<SessionSummary[]> {
  try {
    const raw = await fs.readFile(indexPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SessionSummary[]) : [];
  } catch {
    return [];
  }
}

async function writeIndexJson(rows: SessionSummary[]): Promise<void> {
  await fs.mkdir(dir(), { recursive: true });
  await fs.writeFile(indexPath(), JSON.stringify(rows, null, 2), 'utf8');
}

async function readSessionJson(id: string): Promise<SessionRecord | null> {
  try {
    const raw = await fs.readFile(recordPath(id), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as SessionRecord) : null;
  } catch {
    return null;
  }
}

async function saveSessionJson(record: SessionRecord): Promise<void> {
  await fs.mkdir(dir(), { recursive: true });
  await fs.writeFile(recordPath(record.id), JSON.stringify(record), 'utf8');
  const rows = [summaryOf(record), ...(await readIndexJson()).filter((r) => r.id !== record.id)];
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  const kept = rows.slice(0, MAX_SESSIONS);
  for (const row of rows.slice(MAX_SESSIONS)) {
    await fs.rm(recordPath(row.id), { force: true }).catch(() => {});
  }
  await writeIndexJson(kept);
}

/* ── public, backend-agnostic API ───────────────────────────────────────── */

/** Persist (or replace by id) a session, prune the oldest. Best-effort. */
export async function saveSession(record: SessionRecord): Promise<void> {
  try {
    const db = getDb();
    if (db) {
      await migrateJsonIntoDb(db);
      dbUpsert(db, record);
      return;
    }
    await saveSessionJson(record);
  } catch {
    // best-effort — losing a session record must never break the turn
  }
}

/** Recent sessions, newest first (summaries only). */
export async function listSessions(limit = 30): Promise<SessionSummary[]> {
  const cap = Math.max(1, Math.min(limit, MAX_SESSIONS));
  const db = getDb();
  if (db) {
    await migrateJsonIntoDb(db);
    return db
      .prepare(
        `SELECT id, title, createdAt, updatedAt, provider, model, messageCount
         FROM sessions ORDER BY updatedAt DESC LIMIT ?`,
      )
      .all(cap) as SessionSummary[];
  }
  const rows = await readIndexJson();
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows.slice(0, cap);
}

/** Full-text search saved sessions (title + transcript), newest match first. */
export async function searchSessions(query: string, limit = 30): Promise<SessionSearchHit[]> {
  const cap = Math.max(1, Math.min(limit, MAX_SESSIONS));
  const q = query.trim();
  if (!q) return listSessions(cap);
  const db = getDb();
  if (db) {
    await migrateJsonIntoDb(db);
    // Union two indexes: the word/prefix index (good for whole tokens, e.g.
    // "refac*") and the trigram index (arbitrary substrings + CJK/Hangul, e.g.
    // "팩토"). Dedupe by id, newest first. Either MATCH can throw on an odd
    // query (e.g. trigram needs ≥3 chars) — guard each independently.
    const byId = new Map<string, SessionSearchHit>();
    const runMatch = (table: string, match: string) => {
      try {
        const rows = db
          .prepare(
            `SELECT s.id, s.title, s.createdAt, s.updatedAt, s.provider, s.model, s.messageCount,
                    snippet(${table}, 2, '⟦', '⟧', '…', 12) AS snippet
             FROM ${table} f JOIN sessions s ON s.id = f.id
             WHERE ${table} MATCH ?
             ORDER BY s.updatedAt DESC LIMIT ?`,
          )
          .all(match, cap) as SessionSearchHit[];
        for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);
      } catch {
        // skip this index for this query
      }
    };
    const wordMatch = ftsQuery(q);
    if (wordMatch) runMatch('sessions_fts', wordMatch);
    // Trigram takes the raw query as a quoted substring (no prefix star).
    runMatch('sessions_fts_trigram', `"${q.replace(/"/g, '""')}"`);
    return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, cap);
  }
  // JSON fallback: scan record files for the substring (case-insensitive).
  const needle = q.toLowerCase();
  const rows = await readIndexJson();
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  const hits: SessionSearchHit[] = [];
  for (const row of rows) {
    const rec = await readSessionJson(row.id);
    if (!rec) continue;
    const body = flattenBody(rec);
    const at = body.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    const start = Math.max(0, at - 40);
    hits.push({ ...row, snippet: `…${body.slice(start, at + needle.length + 40)}…` });
    if (hits.length >= cap) break;
  }
  return hits;
}

/** A full saved session by id, or null when not found / unreadable. */
export async function readSession(id: string): Promise<SessionRecord | null> {
  const db = getDb();
  if (db) {
    await migrateJsonIntoDb(db);
    try {
      const row = db.prepare('SELECT record FROM sessions WHERE id = ?').get(id) as
        | { record: string }
        | undefined;
      if (!row) return null;
      const parsed = JSON.parse(row.record);
      return parsed && typeof parsed === 'object' ? (parsed as SessionRecord) : null;
    } catch {
      return null;
    }
  }
  return readSessionJson(id);
}

/** Delete a saved session. Best-effort; returns whether it succeeded. */
export async function deleteSession(id: string): Promise<boolean> {
  const db = getDb();
  if (db) {
    try {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      for (const table of FTS_TABLES) db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      return true;
    } catch {
      return false;
    }
  }
  try {
    await fs.rm(recordPath(id), { force: true });
    const rows = (await readIndexJson()).filter((r) => r.id !== id);
    await writeIndexJson(rows);
    return true;
  } catch {
    return false;
  }
}

/** Delete every saved session. Returns the number removed (best-effort). */
export async function clearAllSessions(): Promise<number> {
  const db = getDb();
  if (db) {
    try {
      const n = (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
      db.exec(`DELETE FROM sessions; DELETE FROM ${FTS_TABLES.join('; DELETE FROM ')};`);
      return n;
    } catch {
      return 0;
    }
  }
  try {
    const rows = await readIndexJson();
    for (const row of rows) await fs.rm(recordPath(row.id), { force: true }).catch(() => {});
    await writeIndexJson([]);
    return rows.length;
  } catch {
    return 0;
  }
}

/** Session-store stats for the Data & Storage settings panel. */
export async function sessionStats(): Promise<StorageStats> {
  const db = getDb();
  if (db) {
    try {
      const count = (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
      const bytes =
        (db.prepare('SELECT COALESCE(SUM(LENGTH(record)),0) AS b FROM sessions').get() as {
          b: number;
        }).b ?? 0;
      return { backend: 'sqlite', sessionCount: count, sessionBytes: bytes };
    } catch {
      return { backend: 'sqlite', sessionCount: 0, sessionBytes: 0 };
    }
  }
  let bytes = 0;
  const rows = await readIndexJson();
  for (const row of rows) {
    try {
      bytes += (await fs.stat(recordPath(row.id))).size;
    } catch {
      // ignore a missing record file
    }
  }
  return { backend: 'json', sessionCount: rows.length, sessionBytes: bytes };
}
