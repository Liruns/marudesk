import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { MemoryEntry, MemoryEntryFull } from '../../shared/context';
import { atomicWriteFile } from '../fs-safe';

/**
 * Persistent memory for the AI Chat (docs/context-mcp-design §4.2) — notes that
 * survive across turns and sessions, modeled on Claude Code's own memory: one
 * human-editable markdown file per entry under userData/marudesk-memory/. The
 * agent reads it (`read_memory` / `list_memory`) to recall durable facts and
 * writes it (`write_memory`) to remember new ones. The user can open/edit these
 * files directly outside the app.
 */

const MAX_ENTRIES = 500;
const MAX_BODY = 16_000;

function dir(): string {
  return path.join(app.getPath('userData'), 'marudesk-memory');
}

/** Normalize a memory name to a safe kebab slug confined to the memory dir. */
export function memorySlug(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return base || 'untitled';
}

function filePath(name: string): string {
  return path.join(dir(), `${memorySlug(name)}.md`);
}

/** All memory entries (metadata only), newest first. */
export async function listMemory(): Promise<MemoryEntry[]> {
  try {
    const names = (await fs.readdir(dir())).filter((n) => n.endsWith('.md'));
    const out: MemoryEntry[] = [];
    for (const n of names) {
      const full = path.join(dir(), n);
      const [stat, body] = await Promise.all([
        fs.stat(full).catch(() => null),
        fs.readFile(full, 'utf8').catch(() => ''),
      ]);
      out.push({ name: n.slice(0, -3), updatedAt: stat?.mtimeMs ?? 0, preview: body.trim().slice(0, 120) });
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  } catch {
    return [];
  }
}

/** Build a ~120-char preview centered on the first matched token (else the head). */
function previewAround(body: string, tokens: string[]): string {
  const lower = body.toLowerCase();
  let idx = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i >= 0 && (idx < 0 || i < idx)) idx = i;
  }
  if (idx < 0) return body.trim().slice(0, 120);
  const start = Math.max(0, idx - 40);
  return (start > 0 ? '…' : '') + body.slice(start, start + 120).trim();
}

/**
 * Full-text search across memory note names + bodies (v6 §W3). Memory lives as
 * user-editable markdown files on disk (which can change outside the app), so this
 * scans them on demand rather than keeping a separate FTS index that could desync
 * from disk truth — and the bounded set (≤{@link MAX_ENTRIES} small files) makes a
 * scan cheap. Requires every whitespace-separated token to appear; ranks name hits
 * above body hits, then by recency. An empty query falls back to {@link listMemory}.
 */
export async function searchMemory(query: string): Promise<MemoryEntry[]> {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return listMemory();
  try {
    const names = (await fs.readdir(dir())).filter((n) => n.endsWith('.md'));
    const scored: { entry: MemoryEntry; score: number }[] = [];
    for (const n of names) {
      const full = path.join(dir(), n);
      const [stat, body] = await Promise.all([
        fs.stat(full).catch(() => null),
        fs.readFile(full, 'utf8').catch(() => ''),
      ]);
      const name = n.slice(0, -3);
      const hayName = name.toLowerCase();
      const hayBody = body.toLowerCase();
      if (!tokens.every((t) => hayName.includes(t) || hayBody.includes(t))) continue;
      let score = 0;
      for (const t of tokens) {
        if (hayName.includes(t)) score += 5;
        if (hayBody.includes(t)) score += 1;
      }
      scored.push({
        entry: { name, updatedAt: stat?.mtimeMs ?? 0, preview: previewAround(body, tokens) },
        score,
      });
    }
    scored.sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt);
    return scored.map((s) => s.entry);
  } catch {
    return [];
  }
}

/** One memory entry's full body, or null when it doesn't exist. */
export async function readMemory(name: string): Promise<MemoryEntryFull | null> {
  try {
    const fp = filePath(name);
    const [stat, body] = await Promise.all([fs.stat(fp), fs.readFile(fp, 'utf8')]);
    return { name: memorySlug(name), updatedAt: stat.mtimeMs, preview: body.trim().slice(0, 120), body };
  } catch {
    return null;
  }
}

/** Create or overwrite a memory entry. Caps body size; auto-evicts at the count cap. */
export async function writeMemory(
  name: string,
  body: string,
): Promise<{ ok: boolean; name: string; reason?: string; evicted?: string[] }> {
  const slug = memorySlug(name);
  try {
    await fs.mkdir(dir(), { recursive: true });
    const existing = (await fs.readdir(dir()).catch(() => [])).filter((n) => n.endsWith('.md'));
    const isNew = !existing.includes(`${slug}.md`);
    // At the cap, evict the oldest notes (LRU by mtime) to make room instead of
    // refusing the write (v6 §W3) — durable memory shouldn't silently stop
    // accepting new facts. Only triggers for a genuinely new entry.
    const evicted: string[] = [];
    if (isNew && existing.length >= MAX_ENTRIES) {
      const stats = await Promise.all(
        existing.map(async (f) => ({
          f,
          m: (await fs.stat(path.join(dir(), f)).catch(() => null))?.mtimeMs ?? 0,
        })),
      );
      stats.sort((a, b) => a.m - b.m); // oldest first
      const need = existing.length - MAX_ENTRIES + 1;
      for (let i = 0; i < need && i < stats.length; i++) {
        await fs.rm(path.join(dir(), stats[i].f), { force: true }).catch(() => undefined);
        evicted.push(stats[i].f.slice(0, -3));
      }
    }
    // Atomic write (temp + rename) so a concurrent write_memory, or the user
    // editing the file at the same time, can't interleave into a half-written
    // file (audit H8). atomicWriteFile replaces the destination on rename.
    await atomicWriteFile(filePath(slug), body.slice(0, MAX_BODY));
    return { ok: true, name: slug, evicted: evicted.length > 0 ? evicted : undefined };
  } catch (err) {
    return { ok: false, name: slug, reason: (err as Error).message };
  }
}

/** Remove a memory entry (kept for a future memory UI; not yet a tool). */
export async function deleteMemory(name: string): Promise<boolean> {
  try {
    await fs.rm(filePath(name), { force: true });
    return true;
  } catch {
    return false;
  }
}
