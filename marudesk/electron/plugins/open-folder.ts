import fs from 'node:fs/promises';

export type OpenPath = (path: string) => Promise<string>;

export async function openUserPluginsFolder(
  dir: string,
  openPath: OpenPath,
): Promise<{ path: string }> {
  await fs.mkdir(dir, { recursive: true });
  const err = await openPath(dir);
  if (err) throw new Error(err);
  return { path: dir };
}
