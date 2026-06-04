/**
 * Tunables and lexical sets for the workspace indexer (workspace.ts) and the
 * file search (search.ts). Kept apart from the scanning logic so the limits and
 * word lists can be reviewed/extended in one place without wading through the
 * walk + summarize code, and so search.ts can share `IGNORE_DIRS` without
 * importing the whole indexer module.
 */

/** Hard cap on indexed files; protects against pathological monorepos. */
export const MAX_FILES = 5000;
/** Skip files larger than this when scanning content for tags/ranking. */
export const MAX_FILE_SIZE = 256 * 1024;
/**
 * Largest file the agent reads in full as a line-addressable document (for
 * paged reads and edit/staleness anchoring). Aligned with the patch apply limit
 * so anything the agent can edit, it can also read in full.
 */
export const MAX_AGENT_FILE_SIZE = 4 * 1024 * 1024;
/** How many top-ranked files get a content read during summarization. */
export const CONTENT_CANDIDATES = 50;
/** How many results the ranked summary keeps. */
export const TOP_RESULTS = 10;

/** Extensions worth scanning for content-derived tags. */
export const INDEXABLE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.astro',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
]);

/** Directories never walked by the indexer or the search. */
export const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.vercel',
  '.output',
  'coverage',
  'release',
]);

/** HTML/SVG tag names dropped from content-derived tags (too generic). */
export const COMMON_TAGS = new Set([
  'div',
  'span',
  'p',
  'a',
  'ul',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'img',
  'svg',
  'path',
  'br',
  'hr',
  'tr',
  'td',
  'th',
]);

/** Common English words dropped from keyword extraction. */
export const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'are',
  'with',
  'you',
  'have',
  'this',
  'that',
  'from',
  'not',
  'but',
  'all',
  'any',
  'can',
  'has',
  'will',
  'was',
  'were',
  'been',
  'they',
  'their',
  'them',
  'than',
  'into',
  'over',
  'your',
  'our',
  'its',
  'who',
  'what',
  'when',
  'where',
  'why',
  'how',
]);
