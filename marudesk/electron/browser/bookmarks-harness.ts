import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createBookmarksStore, parseBookmarks } from './bookmarks-core.ts';
import { check, passedCount } from '../harness-kit.ts';
import type { BookmarkEntry } from '../../shared/bookmarks';

/**
 * Plain-Node harness for the bookmarks store core (no Electron binary needed):
 * add/remove/update semantics, change notifications, and the persist → reload
 * round-trip against a real temp file. Run via `npm run harness:bookmarks`.
 */

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marudesk-bookmarks-'));
const file = path.join(dir, 'bookmarks.json');

try {
  /* ── parse hardening ──────────────────────────────────────────────────── */

  check('parse: corrupt JSON yields empty list', parseBookmarks('{nope').length === 0);
  check('parse: non-array JSON yields empty list', parseBookmarks('{"a":1}').length === 0);
  check(
    'parse: malformed entries are dropped, valid ones kept',
    parseBookmarks(
      JSON.stringify([
        { id: 'a', url: 'https://a.test/', title: 'A', createdAt: 1 },
        { id: '', url: 'https://broken.test/' },
        'junk',
        { id: 'a', url: 'https://dup.test/', title: 'dup id', createdAt: 2 },
      ]),
    ).length === 1,
  );

  /* ── add / remove / update ────────────────────────────────────────────── */

  let pushes: BookmarkEntry[][] = [];
  const store = createBookmarksStore(
    () => file,
    (list) => pushes.push(list),
  );

  check('list: starts empty for a missing file', (await store.list()).length === 0);

  const first = await store.add({ url: 'https://a.test/', title: 'Alpha' });
  const second = await store.add({
    url: 'https://b.test/',
    title: 'Beta',
    faviconUrl: 'data:image/png;base64,AA==',
  });
  check('add: assigns distinct ids', first.id !== second.id && first.id.length > 0);

  const afterAdds = await store.list();
  check('add: list keeps newest first', afterAdds[0]?.id === second.id);
  check('add: favicon round-trips', afterAdds[0]?.faviconUrl === 'data:image/png;base64,AA==');

  const dupe = await store.add({ url: 'https://a.test/', title: 'Alpha again' });
  check('add: same URL dedupes to the existing entry', dupe.id === first.id);
  check('add: dedupe does not grow the list', (await store.list()).length === 2);

  const renamed = await store.update(first.id, { title: 'Alpha renamed' });
  check('update: renames the entry', renamed?.title === 'Alpha renamed');
  check('update: unknown id yields null', (await store.update('bm-missing', { title: 'x' })) === null);

  check('findByUrl: hits a bookmarked URL', (await store.findByUrl('https://a.test/'))?.id === first.id);
  check('findByUrl: misses an unknown URL', (await store.findByUrl('https://nope.test/')) === null);

  check('remove: drops the entry', (await store.remove(second.id)) === true);
  check('remove: unknown id is false', (await store.remove(second.id)) === false);
  check('remove: list shrinks', (await store.list()).length === 1);

  check(
    'onChange: fires per effective mutation only (2 adds + 1 update + 1 remove; deduped add is silent)',
    pushes.length === 4,
  );
  check('onChange: carries the fresh list', pushes[3]?.length === 1);

  /* ── persist round-trip ───────────────────────────────────────────────── */

  const raw = await fs.readFile(file, 'utf8');
  check('persist: file holds valid JSON', parseBookmarks(raw).length === 1);

  pushes = [];
  const reloaded = createBookmarksStore(() => file);
  const restored = await reloaded.list();
  check('reload: a fresh store reads the persisted set', restored.length === 1);
  check('reload: entry fields survive the round-trip', restored[0]?.title === 'Alpha renamed');
  check('reload: createdAt survives the round-trip', restored[0]?.createdAt === first.createdAt);

  console.log(`\nbookmarks harness: ${passedCount()} assertions passed`);
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
