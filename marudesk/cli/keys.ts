/**
 * Raw-mode stdin decoder for the chat TUI (chat CLI v2 — docs/chat-cli-tui-design.md
 * §5). Turns a byte stream into discrete key events: printable chars (UTF-8,
 * possibly split across chunks), control keys, CSI/SS3 escape sequences, and
 * bracketed paste. Pure state machine — the caller owns timers (a trailing lone
 * ESC is held until {@link KeyDecoder.flushEscape} so Esc-the-key can be told
 * apart from the start of a sequence).
 */

export type KeyEvent =
  | { type: 'char'; ch: string }
  | { type: 'paste'; text: string }
  | { type: 'enter' }
  | { type: 'tab' }
  | { type: 'shift-tab' }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'esc' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'word-left' }
  | { type: 'word-right' }
  | { type: 'ctrl'; ch: string };

const ESC = 0x1b;

const CSI_FINAL: Record<string, KeyEvent | undefined> = {
  A: { type: 'up' },
  B: { type: 'down' },
  C: { type: 'right' },
  D: { type: 'left' },
  H: { type: 'home' },
  F: { type: 'end' },
  Z: { type: 'shift-tab' },
};

/** CSI sequences with a numeric prefix + `~` final (vt-style keys). */
const CSI_TILDE: Record<string, KeyEvent | undefined> = {
  '1': { type: 'home' },
  '3': { type: 'delete' },
  '4': { type: 'end' },
  '7': { type: 'home' },
  '8': { type: 'end' },
};

export class KeyDecoder {
  private buf = '';
  private pasting = false;
  private paste = '';
  // Carry partial UTF-8 sequences across chunks (Korean IME input arrives as
  // multi-byte runs that a chunk boundary can split).
  private pendingBytes: number[] = [];

  /** Decode one stdin chunk into events. May leave a trailing lone ESC buffered. */
  push(chunk: Buffer): KeyEvent[] {
    const bytes = this.pendingBytes.length > 0
      ? Buffer.from([...this.pendingBytes, ...chunk])
      : chunk;
    this.pendingBytes = [];
    const keep = trailingPartialUtf8(bytes);
    const usable = keep > 0 ? bytes.subarray(0, bytes.length - keep) : bytes;
    if (keep > 0) this.pendingBytes = [...bytes.subarray(bytes.length - keep)];
    this.buf += usable.toString('utf8');
    return this.drain();
  }

  /** True when a lone ESC is buffered awaiting disambiguation. */
  hasPendingEscape(): boolean {
    return this.buf.length === 1 && this.buf.charCodeAt(0) === ESC;
  }

  /** Resolve a buffered lone ESC as the Esc key (call after a short timer). */
  flushEscape(): KeyEvent[] {
    if (!this.hasPendingEscape()) return [];
    this.buf = '';
    return [{ type: 'esc' }];
  }

  private drain(): KeyEvent[] {
    const out: KeyEvent[] = [];
    for (;;) {
      if (this.buf.length === 0) break;

      if (this.pasting) {
        const end = this.buf.indexOf('\x1b[201~');
        if (end < 0) {
          // Paste still streaming; hold everything (minus a possible partial
          // terminator) until the closing marker arrives.
          const safe = holdbackForMarker(this.buf);
          this.paste += this.buf.slice(0, this.buf.length - safe);
          this.buf = this.buf.slice(this.buf.length - safe);
          break;
        }
        this.paste += this.buf.slice(0, end);
        this.buf = this.buf.slice(end + 6);
        out.push({ type: 'paste', text: this.paste.replace(/\r\n?/g, '\n') });
        this.paste = '';
        this.pasting = false;
        continue;
      }

      const code = this.buf.charCodeAt(0);
      if (code === ESC) {
        const parsed = this.parseEscape();
        if (parsed === 'incomplete') break;
        if (parsed) out.push(parsed);
        continue;
      }

      const ch = this.buf[0];
      this.buf = this.buf.slice(1);
      if (ch === '\r' || ch === '\n') out.push({ type: 'enter' });
      else if (ch === '\t') out.push({ type: 'tab' });
      else if (code === 0x7f || code === 0x08) out.push({ type: 'backspace' });
      else if (code < 0x20) {
        // Ctrl+A..Z → 0x01..0x1a (Ctrl+I/M are tab/enter, handled above).
        out.push({ type: 'ctrl', ch: String.fromCharCode(code + 96) });
      } else {
        // Take the full code point (surrogate pair = 2 units).
        if (code >= 0xd800 && code <= 0xdbff && this.buf.length > 0) {
          out.push({ type: 'char', ch: ch + this.buf[0] });
          this.buf = this.buf.slice(1);
        } else {
          out.push({ type: 'char', ch });
        }
      }
    }
    return out;
  }

  /** Parse one escape sequence at buf[0]; 'incomplete' = wait for more bytes. */
  private parseEscape(): KeyEvent | null | 'incomplete' {
    if (this.buf.length === 1) return 'incomplete'; // lone ESC — caller's timer decides
    const second = this.buf[1];

    if (second === '[') {
      // CSI: \x1b[ params final — final byte is 0x40–0x7e.
      let i = 2;
      while (i < this.buf.length && !isCsiFinal(this.buf.charCodeAt(i))) i++;
      if (i >= this.buf.length) return 'incomplete';
      const params = this.buf.slice(2, i);
      const final = this.buf[i];
      this.buf = this.buf.slice(i + 1);
      if (params === '200' && final === '~') {
        this.pasting = true;
        return null;
      }
      if (final === '~') return CSI_TILDE[params.split(';')[0]] ?? null;
      // Modified arrows: \x1b[1;5C (ctrl+→) / 1;5D — treat ctrl/alt as word moves.
      const mod = params.split(';')[1];
      if ((mod === '5' || mod === '3') && final === 'C') return { type: 'word-right' };
      if ((mod === '5' || mod === '3') && final === 'D') return { type: 'word-left' };
      return CSI_FINAL[final] ?? null;
    }

    if (second === 'O') {
      // SS3 (application cursor keys): \x1bO[ABCDHF].
      if (this.buf.length < 3) return 'incomplete';
      const final = this.buf[2];
      this.buf = this.buf.slice(3);
      return CSI_FINAL[final] ?? null;
    }

    // Alt+key: \x1b then a printable — map alt+b/f to word moves, else ignore.
    this.buf = this.buf.slice(2);
    if (second === 'b') return { type: 'word-left' };
    if (second === 'f') return { type: 'word-right' };
    if (second === '\r' || second === '\n') return { type: 'enter' };
    return null;
  }
}

function isCsiFinal(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

/**
 * How many trailing bytes of `bytes` are an incomplete UTF-8 sequence (0–3).
 * Buffer#toString would replace them with U+FFFD, corrupting split CJK input.
 */
function trailingPartialUtf8(bytes: Buffer): number {
  const len = bytes.length;
  for (let back = 1; back <= 3 && back <= len; back++) {
    const b = bytes[len - back];
    if ((b & 0b1100_0000) === 0b1000_0000) continue; // continuation byte — keep looking
    // Lead byte found `back` bytes from the end; how long should its sequence be?
    let need = 1;
    if ((b & 0b1110_0000) === 0b1100_0000) need = 2;
    else if ((b & 0b1111_0000) === 0b1110_0000) need = 3;
    else if ((b & 0b1111_1000) === 0b1111_0000) need = 4;
    return back < need ? back : 0;
  }
  return 0;
}

/**
 * While pasting, hold back a buffer tail that could be the start of the
 * `\x1b[201~` terminator split across chunks.
 */
function holdbackForMarker(buf: string): number {
  const marker = '\x1b[201~';
  for (let k = Math.min(marker.length - 1, buf.length); k > 0; k--) {
    if (buf.endsWith(marker.slice(0, k))) return k;
  }
  return 0;
}
