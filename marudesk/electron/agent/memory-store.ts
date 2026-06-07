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

/** Create or overwrite a memory entry. Caps the entry count and body size. */
export async function writeMemory(
  name: string,
  body: string,
): Promise<{ ok: boolean; name: string; reason?: string }> {
  const slug = memorySlug(name);
  try {
    await fs.mkdir(dir(), { recursive: true });
    const existing = (await fs.readdir(dir()).catch(() => [])).filter((n) => n.endsWith('.md'));
    const isNew = !existing.includes(`${slug}.md`);
    if (isNew && existing.length >= MAX_ENTRIES) {
      return { ok: false, name: slug, reason: `memory is full (${MAX_ENTRIES} entries) — delete some first` };
    }
    // Atomic write (temp + rename) so a concurrent write_memory, or the user
    // editing the file at the same time, can't interleave into a half-written
    // file (audit H8). atomicWriteFile replaces the destination on rename.
    await atomicWriteFile(filePath(slug), body.slice(0, MAX_BODY));
    return { ok: true, name: slug };
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
