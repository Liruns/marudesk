import { describe, expect, it } from 'vitest';
import {
  decodeBase64Text,
  decodeSourceMapDataUrl,
  defaultSourceIndex,
  generatedPositionFor,
  originalPositionFor,
  parseSourceMap,
  resolveSourceUrl,
  resolveUrl,
} from './source-map';

/**
 * A real source map produced by `tsc --sourceMap --inlineSources` over:
 *
 *   const greeting: string = "hello";
 *   function shout(s: string): string {
 *     return s.toUpperCase();
 *   }
 *   console.log(shout(greeting));
 *
 * Generated output (line 0 is the unmapped `"use strict";`):
 *
 *   "use strict";
 *   const greeting = "hello";
 *   function shout(s) {
 *       return s.toUpperCase();
 *   }
 *   console.log(shout(greeting));
 */
const TSC_MAP = {
  version: 3,
  file: 'src.js',
  sourceRoot: '',
  sources: ['src.ts'],
  names: [],
  mappings:
    ';AAAA,MAAM,QAAQ,GAAW,OAAO,CAAC;AACjC,SAAS,KAAK,CAAC,CAAS;IACtB,OAAO,CAAC,CAAC,WAAW,EAAE,CAAC;AACzB,CAAC;AACD,OAAO,CAAC,GAAG,CAAC,KAAK,CAAC,QAAQ,CAAC,CAAC,CAAC',
  sourcesContent: [
    'const greeting: string = "hello";\nfunction shout(s: string): string {\n  return s.toUpperCase();\n}\nconsole.log(shout(greeting));\n',
  ],
};

describe('parseSourceMap', () => {
  it('rejects non-v3 / malformed shells', () => {
    expect(parseSourceMap(null)).toBeNull();
    expect(parseSourceMap('nope')).toBeNull();
    expect(parseSourceMap({ version: 2, sources: [], mappings: '' })).toBeNull();
    expect(parseSourceMap({ version: 3, mappings: '' })).toBeNull();
    expect(parseSourceMap({ version: 3, sources: [] })).toBeNull();
    // Indexed (sections) maps are unsupported.
    expect(parseSourceMap({ version: 3, sections: [], sources: [], mappings: '' })).toBeNull();
  });

  it('rejects malformed mappings but accepts an empty string', () => {
    expect(parseSourceMap({ version: 3, sources: ['a'], mappings: '!!' })).toBeNull();
    // 2-field segments don't exist in v3.
    expect(parseSourceMap({ version: 3, sources: ['a'], mappings: 'AA' })).toBeNull();
    const empty = parseSourceMap({ version: 3, sources: ['a'], mappings: '' });
    expect(empty?.mappings).toEqual([]);
    expect(empty?.sourcesContent).toEqual([null]);
  });

  it('decodes a hand-built map (4-field segments, per-line column reset, negative delta)', () => {
    // gen(0,0)→orig(0,0) · gen(0,4)→orig(0,6) · gen(1,0)→orig(1,0)
    // "AAAA,IAAM;AACN": I=+4, M=+6, C=+1, N=-6.
    const map = parseSourceMap({
      version: 3,
      sources: ['src.ts'],
      mappings: 'AAAA,IAAM;AACN',
    });
    expect(map?.mappings).toEqual([
      { genLine: 0, genCol: 0, srcIndex: 0, origLine: 0, origCol: 0 },
      { genLine: 0, genCol: 4, srcIndex: 0, origLine: 0, origCol: 6 },
      { genLine: 1, genCol: 0, srcIndex: 0, origLine: 1, origCol: 0 },
    ]);
  });

  it('decodes multi-digit VLQ values (continuation bit)', () => {
    // "iB" = +17, "gB" = +16 — both need a continuation digit.
    const map = parseSourceMap({
      version: 3,
      sources: ['a.ts'],
      mappings: 'iBAgBA',
    });
    expect(map?.mappings).toEqual([
      { genLine: 0, genCol: 17, srcIndex: 0, origLine: 16, origCol: 0 },
    ]);
  });

  it('skips generated-only (1-field) segments but advances the column', () => {
    // gen col 0 mapped; then a 1-field segment (+4); then a mapped one at +2.
    const map = parseSourceMap({
      version: 3,
      sources: ['a.ts'],
      mappings: 'AAAA,I,EAAA',
    });
    expect(map?.mappings).toEqual([
      { genLine: 0, genCol: 0, srcIndex: 0, origLine: 0, origCol: 0 },
      { genLine: 0, genCol: 6, srcIndex: 0, origLine: 0, origCol: 0 },
    ]);
  });

  it('parses the real tsc-generated fixture', () => {
    const map = parseSourceMap(TSC_MAP);
    expect(map).not.toBeNull();
    expect(map?.sources).toEqual(['src.ts']);
    expect(map?.sourcesContent[0]).toContain('const greeting: string');
    // The first mapped generated line is 1 ("use strict" is unmapped).
    expect(map?.mappings[0]).toEqual({
      genLine: 1,
      genCol: 0,
      srcIndex: 0,
      origLine: 0,
      origCol: 0,
    });
  });
});

describe('originalPositionFor', () => {
  const map = parseSourceMap(TSC_MAP)!;

  it('maps an exact generated position to its original one', () => {
    // gen line 1 col 17 is `"hello"` → orig line 0 col 25.
    expect(originalPositionFor(map, 1, 17)).toEqual({
      srcIndex: 0,
      line: 0,
      column: 25,
    });
    // gen line 3 col 4 is `return` → orig line 2 col 2.
    expect(originalPositionFor(map, 3, 4)).toEqual({ srcIndex: 0, line: 2, column: 2 });
  });

  it('snaps to the nearest mapping at-or-before the column on the same line', () => {
    // col 2 has no segment of its own — the line-start mapping (col 0) wins.
    expect(originalPositionFor(map, 1, 2)).toEqual({ srcIndex: 0, line: 0, column: 0 });
  });

  it('returns null for an unmapped generated line', () => {
    expect(originalPositionFor(map, 0, 0)).toBeNull(); // "use strict";
    expect(originalPositionFor(map, 99, 0)).toBeNull();
  });
});

describe('generatedPositionFor', () => {
  const map = parseSourceMap(TSC_MAP)!;

  it('maps an original line to its generated position', () => {
    expect(generatedPositionFor(map, 0, 0)).toEqual({ line: 1, column: 0 });
    expect(generatedPositionFor(map, 0, 2)).toEqual({ line: 3, column: 4 });
  });

  it('maps the last original line exactly', () => {
    expect(generatedPositionFor(map, 0, 4)).toEqual({ line: 5, column: 0 });
  });

  it('slides down to the nearest mapping at-or-after an unmapped line', () => {
    // gen line 0 → orig line 0, gen line 1 → orig line 5 ("AAKA": K = +5).
    const gappy = parseSourceMap({
      version: 3,
      sources: ['a.ts'],
      mappings: 'AAAA;AAKA',
    })!;
    expect(generatedPositionFor(gappy, 0, 2)).toEqual({ line: 1, column: 0 });
  });

  it('returns null past the end of the source / for unknown sources', () => {
    expect(generatedPositionFor(map, 0, 99)).toBeNull();
    expect(generatedPositionFor(map, 7, 0)).toBeNull();
  });
});

describe('defaultSourceIndex', () => {
  it('uses the first mapping (and 0 for an empty map)', () => {
    const map = parseSourceMap(TSC_MAP)!;
    expect(defaultSourceIndex(map)).toBe(0);
    const empty = parseSourceMap({ version: 3, sources: ['a'], mappings: '' })!;
    expect(defaultSourceIndex(empty)).toBe(0);
  });
});

/**
 * Browser-safe UTF-8 → base64 (the renderer test env has no node `Buffer`).
 * Inverse of {@link decodeBase64Text}: UTF-8-encode, pack the bytes into a
 * binary string, then btoa.
 */
function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe('decodeSourceMapDataUrl', () => {
  it('decodes base64 data: URLs', () => {
    const json = JSON.stringify({ version: 3, sources: ['x.ts'], mappings: 'AAAA' });
    const b64 = toBase64Utf8(json);
    const decoded = decodeSourceMapDataUrl(
      `data:application/json;charset=utf-8;base64,${b64}`,
    );
    expect(decoded).toBe(json);
    expect(parseSourceMap(JSON.parse(decoded!))).not.toBeNull();
  });

  it('decodes percent-encoded non-base64 data: URLs', () => {
    expect(decodeSourceMapDataUrl('data:application/json,%7B%22a%22%3A1%7D')).toBe(
      '{"a":1}',
    );
  });

  it('returns null for non-data URLs and garbage payloads', () => {
    expect(decodeSourceMapDataUrl('https://x.test/app.js.map')).toBeNull();
    expect(decodeSourceMapDataUrl('data:application/json;base64,@@@')).toBeNull();
    expect(decodeSourceMapDataUrl('data:nope')).toBeNull();
  });
});

describe('decodeBase64Text', () => {
  it('decodes UTF-8 payloads', () => {
    const b64 = toBase64Utf8('héllo → 世界');
    expect(decodeBase64Text(b64)).toBe('héllo → 世界');
  });

  it('returns null on invalid base64', () => {
    expect(decodeBase64Text('@@@')).toBeNull();
  });
});

describe('resolveUrl / resolveSourceUrl', () => {
  it('resolves a relative map URL against the script URL', () => {
    expect(resolveUrl('app.js.map', 'https://x.test/assets/app.js')).toBe(
      'https://x.test/assets/app.js.map',
    );
    expect(resolveUrl('/maps/app.js.map', 'https://x.test/assets/app.js')).toBe(
      'https://x.test/maps/app.js.map',
    );
    expect(resolveUrl('rel.map', 'not a url')).toBeNull();
  });

  it('passes absolute sources (incl. webpack://) through untouched', () => {
    expect(resolveSourceUrl('', 'webpack://app/src/main.ts', 'https://x.test/b.js')).toBe(
      'webpack://app/src/main.ts',
    );
    expect(resolveSourceUrl('', 'https://y.test/s.ts', 'https://x.test/b.js')).toBe(
      'https://y.test/s.ts',
    );
  });

  it('prepends sourceRoot then resolves against the script URL', () => {
    expect(resolveSourceUrl('../src', 'main.ts', 'https://x.test/dist/app.js')).toBe(
      'https://x.test/src/main.ts',
    );
    expect(
      resolveSourceUrl('webpack://app/', 'src/main.ts', 'https://x.test/app.js'),
    ).toBe('webpack://app/src/main.ts');
  });

  it('falls back to the joined raw value when unresolvable', () => {
    expect(resolveSourceUrl('', 'src/main.ts', 'not a url')).toBe('src/main.ts');
  });
});
