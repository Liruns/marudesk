export type ConfigOption = {
  readonly key: string;
  readonly value: string;
};

export type HostBlock = {
  readonly patterns: readonly string[];
  readonly options: readonly ConfigOption[];
};

type MutableHostBlock = {
  patterns: string[];
  options: ConfigOption[];
};

export function parseHostBlocks(content: string): readonly HostBlock[] {
  const blocks: MutableHostBlock[] = [{ patterns: ['*'], options: [] }];
  let current = blocks[0];
  for (const rawLine of content.split(/\r?\n/)) {
    const words = splitWords(stripComment(rawLine).trim());
    if (words.length === 0) continue;
    const key = words[0]?.toLowerCase();
    if (!key) continue;
    if (key === 'host') {
      current = { patterns: words.slice(1), options: [] };
      blocks.push(current);
      continue;
    }
    current.options.push({ key, value: words.slice(1).join(' ') });
  }
  return blocks;
}

export function concreteAliases(blocks: readonly HostBlock[]): readonly string[] {
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const block of blocks) {
    for (const pattern of block.patterns) {
      if (!isConcreteAlias(pattern) || seen.has(pattern)) continue;
      aliases.push(pattern);
      seen.add(pattern);
    }
  }
  return aliases;
}

export function hostBlockMatches(patterns: readonly string[], alias: string): boolean {
  let matched = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    const raw = negated ? pattern.slice(1) : pattern;
    if (!wildcardMatches(raw, alias)) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

function isConcreteAlias(pattern: string): boolean {
  return pattern.length > 0 && !pattern.startsWith('!') && !/[?*]/.test(pattern);
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if ((ch === '"' || ch === "'") && quote === null) {
      quote = ch;
      continue;
    }
    if (ch === quote) {
      quote = null;
      continue;
    }
    if (ch === '#' && quote === null) return line.slice(0, i);
  }
  return line;
}

function splitWords(line: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) words.push(current);
  return words;
}

function wildcardMatches(pattern: string, value: string): boolean {
  return globMatches(pattern, value);
}

export function globMatches(pattern: string, value: string): boolean {
  let source = '^';
  for (const ch of pattern) {
    if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else source += escapeRegexChar(ch);
  }
  source += '$';
  return new RegExp(source).test(value);
}

function escapeRegexChar(ch: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch;
}
