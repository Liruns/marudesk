import path from 'node:path';
import type { CaptureInput, FileEntry, RankedFile } from '../shared/workspace';
import {
  COMMON_TAGS,
  CONTENT_CANDIDATES,
  INDEXABLE_EXTENSIONS,
  MAX_FILE_SIZE,
  STOP_WORDS,
  TOP_RESULTS,
} from './workspace-config';
import { readFileSafe } from './workspace-files';

export async function rankFiles(
  root: string,
  capture: CaptureInput,
  files: readonly FileEntry[],
): Promise<RankedFile[]> {
  const keywords = extractKeywords(capture);
  if (keywords.length === 0) return [];

  const indexable = files.filter((f) =>
    INDEXABLE_EXTENSIONS.has(path.extname(f.path).toLowerCase()),
  );

  const pathScored = indexable.map((f) => {
    const { score, matches } = scorePath(f.path, keywords);
    return { entry: f, pathScore: score, matches };
  });

  pathScored.sort((a, b) => b.pathScore - a.pathScore);
  const candidates = pathScored.slice(0, CONTENT_CANDIDATES);

  const ranked: RankedFile[] = [];
  for (const c of candidates) {
    let contentScore = 0;
    const contentMatches: string[] = [];
    if (c.entry.size <= MAX_FILE_SIZE) {
      try {
        const content = await readFileSafe(root, c.entry.path);
        const lower = content.toLowerCase();
        for (const kw of keywords) {
          const lk = kw.toLowerCase();
          let count = 0;
          let from = 0;
          while (from < lower.length) {
            const i = lower.indexOf(lk, from);
            if (i < 0) break;
            count++;
            if (count >= 10) break;
            from = i + lk.length;
          }
          if (count > 0) {
            contentScore += Math.min(3 + (count - 1), 10);
            contentMatches.push(kw);
          }
        }
      } catch {
        // Skip unreadable candidates.
      }
    }
    const total = c.pathScore + contentScore;
    if (total > 0) {
      ranked.push({
        path: c.entry.path,
        score: total,
        matches: Array.from(new Set([...c.matches, ...contentMatches])),
      });
    }
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, TOP_RESULTS);
}

export function isCaptureInput(value: unknown): value is CaptureInput {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.tagName !== undefined && typeof v.tagName !== 'string') return false;
  if (v.selector !== undefined && typeof v.selector !== 'string') return false;
  if (v.text !== undefined && typeof v.text !== 'string') return false;
  if (v.attributes !== undefined) {
    if (!v.attributes || typeof v.attributes !== 'object') return false;
    for (const [, val] of Object.entries(v.attributes)) {
      if (typeof val !== 'string') return false;
    }
  }
  return true;
}

function extractKeywords(capture: CaptureInput): string[] {
  const set = new Set<string>();

  if (capture.tagName) {
    const tag = capture.tagName.toLowerCase();
    if (tag.length >= 2 && !COMMON_TAGS.has(tag)) {
      set.add(tag);
    }
  }

  const attrs = capture.attributes ?? {};
  const id = attrs.id;
  if (id && id.length >= 2) set.add(id);

  const testId = attrs['data-testid'];
  if (testId && testId.length >= 2) set.add(testId);

  const role = attrs.role;
  if (role && role.length >= 3) set.add(role);

  const cls = attrs.class ?? '';
  for (const token of cls.split(/\s+/)) {
    if (token.length >= 3) set.add(token);
  }

  if (capture.text) {
    const tokens = capture.text
      .split(/[\s\W]+/)
      .filter((t) => t.length >= 3 && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(t))
      .map((t) => t.toLowerCase())
      .filter((t) => !STOP_WORDS.has(t));
    const seen = new Set<string>();
    let count = 0;
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      set.add(t);
      count++;
      if (count >= 6) break;
    }
  }

  return Array.from(set);
}

function scorePath(
  filePath: string,
  keywords: readonly string[],
): { score: number; matches: string[] } {
  const base = path.basename(filePath).toLowerCase();
  const dirParts = path
    .dirname(filePath)
    .toLowerCase()
    .split('/')
    .filter(Boolean);
  const matches: string[] = [];
  let score = 0;
  for (const kw of keywords) {
    const k = kw.toLowerCase();
    if (base.includes(k)) {
      score += 5;
      matches.push(kw);
      continue;
    }
    for (const dp of dirParts) {
      if (dp.includes(k)) {
        score += 2;
        matches.push(kw);
        break;
      }
    }
  }
  return { score, matches };
}
