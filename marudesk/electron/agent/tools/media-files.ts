import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  assertRealInsideRoot,
  assertRealParentInsideRoot,
  lstatOrNull,
  resolveWorkspacePath,
} from '../../fs-safe';
import { globToRegExp } from '../../../shared/glob';

export type WorkspaceDirectory = {
  readonly rel: string;
  readonly abs: string;
};

export function parseOutputDir(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return raw.replace(/\\/g, '/').replace(/\/+$/g, '') || fallback;
}

function assertNotDenied(rel: string, denyGlobs: readonly string[] | undefined): void {
  if (!denyGlobs?.some((glob) => globToRegExp(glob).test(rel))) return;
  throw new Error(`Blocked: "${rel}" matches a denied path glob (Settings -> Agent).`);
}

export async function ensureWorkspaceDirectory(
  root: string,
  relDir: string,
): Promise<WorkspaceDirectory> {
  const raw = resolveWorkspacePath(root, relDir);
  const resolved = {
    rel: path.relative(root, raw.abs).replace(/\\/g, '/') || '.',
    abs: raw.abs,
  };
  const segments = resolved.rel.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  let currentRel = '';
  for (const segment of segments) {
    currentRel = currentRel ? `${currentRel}/${segment}` : segment;
    const current = resolveWorkspacePath(root, currentRel);
    const existing = await lstatOrNull(current.abs);
    if (existing) {
      if (!existing.isDirectory()) throw new Error(`marudesk: path is not a directory: ${current.rel}`);
      await assertRealInsideRoot(root, current.abs);
      continue;
    }
    await assertRealParentInsideRoot(root, current.abs);
    await fs.mkdir(current.abs, { recursive: false });
  }
  await assertRealInsideRoot(root, resolved.abs);
  return resolved;
}

export async function saveGeneratedFile(input: {
  readonly root: string;
  readonly outputDir: WorkspaceDirectory;
  readonly bytes: Uint8Array;
  readonly extension: string;
  readonly denyGlobs: readonly string[] | undefined;
  readonly index?: number;
}): Promise<string> {
  const suffix = input.index === undefined || input.index === 0 ? '' : `-${input.index + 1}`;
  const filename = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}${suffix}.${input.extension}`;
  const rel = input.outputDir.rel === '.' ? filename : `${input.outputDir.rel}/${filename}`;
  const resolved = resolveWorkspacePath(input.root, rel);
  assertNotDenied(resolved.rel, input.denyGlobs);
  await assertRealParentInsideRoot(input.root, resolved.abs);
  const file = await fs.open(resolved.abs, 'wx');
  try {
    await file.writeFile(input.bytes);
  } finally {
    await file.close();
  }
  return resolved.rel;
}
