/**
 * Hand-rolled, dependency-free tokenizer for JavaScript/TypeScript-ish source,
 * powering the Sources viewer's lightweight highlighting. Classifies keywords,
 * strings (incl. template literals), comments (line/block), and numbers;
 * everything else stays plain. Line-oriented: the only cross-line state is a
 * cheap carry for block comments and template literals.
 *
 * Guarantees:
 * - The concatenated token texts ALWAYS equal the input line — highlighting can
 *   never change the displayed text.
 * - Never throws: any internal error degrades that line to a single plain token.
 * - O(n) per line, no regex backtracking — safe for 10k-line minified bundles.
 *
 * Known approximations (styling-only): regex literals are not recognized (their
 * quotes may start a string token), and `${…}` interpolations are colored as
 * part of the enclosing template string.
 */

export type SyntaxTokenKind = 'plain' | 'keyword' | 'string' | 'comment' | 'number';

export type SyntaxToken = { text: string; kind: SyntaxTokenKind };

/** Cross-line tokenizer state: inside a block comment / a template literal. */
export type SyntaxCarry = 'none' | 'comment' | 'template';

const KEYWORDS = new Set([
  // JS
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally',
  'for', 'from', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new',
  'of', 'return', 'static', 'super', 'switch', 'this', 'throw', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield',
  // literals
  'true', 'false', 'null', 'undefined',
  // TS
  'abstract', 'as', 'declare', 'enum', 'implements', 'infer', 'interface',
  'is', 'keyof', 'namespace', 'override', 'private', 'protected', 'public',
  'readonly', 'satisfies', 'type',
]);

function isIdentStart(c: string): boolean {
  return /[A-Za-z_$]/.test(c);
}

function isIdentPart(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c);
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

/** Append `text` as `kind`, merging into the previous token when kinds match. */
function push(tokens: SyntaxToken[], text: string, kind: SyntaxTokenKind): void {
  if (text.length === 0) return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind) last.text += text;
  else tokens.push({ text, kind });
}

/**
 * Scan a quoted string starting at `start` (line[start] is the quote). Returns
 * the index just past the closing quote, or the line end when unterminated.
 */
function scanString(line: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < line.length) {
    const c = line[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    i += 1;
  }
  return line.length;
}

function tokenizeLineUnsafe(
  line: string,
  carry: SyntaxCarry,
): { tokens: SyntaxToken[]; carry: SyntaxCarry } {
  const tokens: SyntaxToken[] = [];
  let i = 0;

  // Resume a multi-line construct from the previous line.
  if (carry === 'comment') {
    const close = line.indexOf('*/');
    if (close === -1) {
      push(tokens, line, 'comment');
      return { tokens, carry: 'comment' };
    }
    push(tokens, line.slice(0, close + 2), 'comment');
    i = close + 2;
  } else if (carry === 'template') {
    const end = scanTemplateEnd(line, 0);
    push(tokens, line.slice(0, end.index), 'string');
    if (!end.closed) return { tokens, carry: 'template' };
    i = end.index;
  }

  while (i < line.length) {
    const c = line[i];
    const next = line[i + 1];

    if (c === '/' && next === '/') {
      push(tokens, line.slice(i), 'comment');
      return { tokens, carry: 'none' };
    }
    if (c === '/' && next === '*') {
      const close = line.indexOf('*/', i + 2);
      if (close === -1) {
        push(tokens, line.slice(i), 'comment');
        return { tokens, carry: 'comment' };
      }
      push(tokens, line.slice(i, close + 2), 'comment');
      i = close + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = scanString(line, i, c);
      push(tokens, line.slice(i, end), 'string');
      i = end;
      continue;
    }
    if (c === '`') {
      const end = scanTemplateEnd(line, i + 1);
      push(tokens, line.slice(i, end.index), 'string');
      if (!end.closed) return { tokens, carry: 'template' };
      i = end.index;
      continue;
    }
    if (isDigit(c) || (c === '.' && next !== undefined && isDigit(next))) {
      let end = i + 1;
      while (end < line.length) {
        const d = line[end];
        if (isIdentPart(d) || d === '.') {
          end += 1;
          continue;
        }
        // Exponent sign: `1e+10` / `2E-3`.
        if (
          (d === '+' || d === '-') &&
          (line[end - 1] === 'e' || line[end - 1] === 'E') &&
          end + 1 <= line.length &&
          isDigit(line[end + 1] ?? '')
        ) {
          end += 1;
          continue;
        }
        break;
      }
      push(tokens, line.slice(i, end), 'number');
      i = end;
      continue;
    }
    if (isIdentStart(c)) {
      let end = i + 1;
      while (end < line.length && isIdentPart(line[end])) end += 1;
      const word = line.slice(i, end);
      // `foo.for` is a property access, not the keyword.
      const prevNonSpace = lastNonSpace(line, i);
      const kind = KEYWORDS.has(word) && prevNonSpace !== '.' ? 'keyword' : 'plain';
      push(tokens, word, kind);
      i = end;
      continue;
    }
    push(tokens, c, 'plain');
    i += 1;
  }
  return { tokens, carry: 'none' };
}

/** The index just past the closing backtick from `start`, or the line end. */
function scanTemplateEnd(line: string, start: number): { index: number; closed: boolean } {
  let i = start;
  while (i < line.length) {
    const c = line[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') return { index: i + 1, closed: true };
    i += 1;
  }
  return { index: line.length, closed: false };
}

function lastNonSpace(line: string, before: number): string {
  for (let i = before - 1; i >= 0; i -= 1) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return c;
  }
  return '';
}

/**
 * Tokenize one line given the previous line's carry state. Never throws — on
 * any internal error the line comes back as a single plain token.
 */
export function tokenizeLine(
  line: string,
  carry: SyntaxCarry = 'none',
): { tokens: SyntaxToken[]; carry: SyntaxCarry } {
  try {
    return tokenizeLineUnsafe(line, carry);
  } catch {
    return { tokens: line.length > 0 ? [{ text: line, kind: 'plain' }] : [], carry: 'none' };
  }
}

/** Tokenize a whole source, threading the block-comment/template carry. */
export function tokenizeLines(lines: readonly string[]): SyntaxToken[][] {
  const out: SyntaxToken[][] = [];
  let carry: SyntaxCarry = 'none';
  for (const line of lines) {
    const res = tokenizeLine(line, carry);
    out.push(res.tokens);
    carry = res.carry;
  }
  return out;
}
