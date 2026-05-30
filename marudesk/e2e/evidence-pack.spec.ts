import { test, expect } from '@playwright/test';
import { formatEvidencePack } from '../shared/evidence-pack';
import { REDACTED } from '../shared/scrub';
import type { Capture } from '../shared/capture';

/** Pure unit coverage for the P1.5 evidence pack: Markdown shape + scrubbing. */

test('evidence-pack: console error → Markdown with message, page, stack', () => {
  const cap: Capture = {
    kind: 'console-error',
    id: 'c1',
    timestamp: 0,
    url: 'http://localhost:5173/app',
    message: 'TypeError: x is not a function',
    stack: [{ functionName: 'render', url: 'http://localhost:5173/src/App.tsx', lineNumber: 41, columnNumber: 2 }],
    source: { url: 'http://localhost:5173/src/App.tsx', lineNumber: 41 },
  };
  const md = formatEvidencePack(cap);
  expect(md).toContain('Console error');
  expect(md).toContain('TypeError: x is not a function');
  expect(md).toContain('App.tsx:42'); // 0-based 41 → 1-based 42
  expect(md).toContain('render');
});

test('evidence-pack: element → tag, selector, attributes', () => {
  const cap: Capture = {
    kind: 'element',
    id: 'e1',
    timestamp: 0,
    url: 'http://localhost:5173/',
    selector: '#submit',
    tagName: 'BUTTON',
    text: 'Save',
    attributes: { id: 'submit', class: 'btn' },
    rect: { x: 0, y: 0, width: 10, height: 10 },
  };
  const md = formatEvidencePack(cap);
  expect(md).toContain('<button>');
  expect(md).toContain('#submit');
  expect(md).toContain('`class` = `btn`');
});

test('evidence-pack: scrubs secrets so a public paste is safe', () => {
  const cap: Capture = {
    kind: 'console-error',
    id: 'c2',
    timestamp: 0,
    url: 'http://localhost:5173/?token=sk-ant-SECRETVALUE0123456789',
    message: 'Auth failed: Bearer abcDEF1234567890ghijkl',
    stack: [],
  };
  const md = formatEvidencePack(cap);
  expect(md).not.toContain('sk-ant-SECRETVALUE0123456789');
  expect(md).not.toContain('abcDEF1234567890ghijkl');
  expect(md).toContain(REDACTED);
});
