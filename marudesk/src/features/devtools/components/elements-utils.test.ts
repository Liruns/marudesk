import { describe, expect, it } from 'vitest';
import type { EventListenerInfo } from '../types';
import {
  fileNameOfUrl,
  formatAxValue,
  formatListenerLocation,
  getAttr,
  groupListenersByType,
  handlerPreview,
  layoutKind,
  toggleVisibilityHidden,
} from './elements-utils';

describe('getAttr', () => {
  it('reads a value from the flat pair array', () => {
    expect(getAttr(['id', 'a', 'class', 'b c'], 'class')).toBe('b c');
  });
  it('returns undefined when missing or no attributes', () => {
    expect(getAttr(['id', 'a'], 'class')).toBeUndefined();
    expect(getAttr(undefined, 'id')).toBeUndefined();
  });
});

describe('toggleVisibilityHidden', () => {
  it('appends to an empty/absent style', () => {
    expect(toggleVisibilityHidden(undefined)).toBe('visibility: hidden');
    expect(toggleVisibilityHidden('')).toBe('visibility: hidden');
  });
  it('appends while preserving existing declarations', () => {
    expect(toggleVisibilityHidden('color: red; margin: 0')).toBe(
      'color: red; margin: 0; visibility: hidden',
    );
  });
  it('removes an existing hidden declaration (toggle off)', () => {
    expect(toggleVisibilityHidden('color: red; visibility: hidden')).toBe('color: red');
    expect(toggleVisibilityHidden('visibility: hidden')).toBe('');
  });
  it('replaces a non-hidden visibility value', () => {
    expect(toggleVisibilityHidden('visibility: visible; color: red')).toBe(
      'visibility: hidden; color: red',
    );
  });
  it('is case/whitespace tolerant', () => {
    expect(toggleVisibilityHidden('  VISIBILITY :  HIDDEN ;; color: red')).toBe('color: red');
  });
  it('does not match prefixed properties like backface-visibility', () => {
    expect(toggleVisibilityHidden('backface-visibility: hidden')).toBe(
      'backface-visibility: hidden; visibility: hidden',
    );
  });
});

const listener = (over: Partial<EventListenerInfo>): EventListenerInfo => ({
  type: 'click',
  useCapture: false,
  passive: false,
  once: false,
  scriptId: '12',
  lineNumber: 4,
  columnNumber: 10,
  ...over,
});

describe('groupListenersByType', () => {
  it('groups by type, sorted alphabetically, preserving listener order', () => {
    const groups = groupListenersByType([
      listener({ type: 'scroll' }),
      listener({ type: 'click', scriptId: 'a' }),
      listener({ type: 'click', scriptId: 'b' }),
    ]);
    expect(groups.map(([t]) => t)).toEqual(['click', 'scroll']);
    expect(groups[0][1].map((l) => l.scriptId)).toEqual(['a', 'b']);
  });
  it('returns empty for no listeners', () => {
    expect(groupListenersByType([])).toEqual([]);
  });
});

describe('fileNameOfUrl', () => {
  it('returns the last path segment', () => {
    expect(fileNameOfUrl('https://x.test/js/app.min.js?v=1')).toBe('app.min.js');
  });
  it('falls back to the host for a bare path', () => {
    expect(fileNameOfUrl('https://x.test/')).toBe('x.test');
  });
  it('returns the input when not a URL', () => {
    expect(fileNameOfUrl('not a url')).toBe('not a url');
  });
});

describe('formatListenerLocation', () => {
  it('uses the resolved url and 1-based line:col', () => {
    expect(formatListenerLocation(listener({}), 'https://x.test/js/app.js')).toBe(
      'app.js:5:11',
    );
  });
  it('falls back to VM<scriptId> when the url is unknown', () => {
    expect(formatListenerLocation(listener({}), undefined)).toBe('VM12:5:11');
  });
});

describe('handlerPreview', () => {
  it('returns the first line, trimmed', () => {
    expect(handlerPreview('function onClick(e) {\n  doIt();\n}')).toBe('function onClick(e) {');
  });
  it('truncates long lines with an ellipsis', () => {
    const long = `function f() { ${'x'.repeat(100)} }`;
    const out = handlerPreview(long, 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith('…')).toBe(true);
  });
  it('returns empty for no description', () => {
    expect(handlerPreview(undefined)).toBe('');
  });
});

describe('formatAxValue', () => {
  it('renders scalars directly', () => {
    expect(formatAxValue({ type: 'string', value: 'Submit' })).toBe('Submit');
    expect(formatAxValue({ type: 'boolean', value: true })).toBe('true');
    expect(formatAxValue({ type: 'integer', value: 3 })).toBe('3');
  });
  it('JSON-stringifies structured values', () => {
    expect(formatAxValue({ type: 'idrefList', value: [{ backendDOMNodeId: 1 }] })).toBe(
      '[{"backendDOMNodeId":1}]',
    );
  });
  it('returns empty when there is no value', () => {
    expect(formatAxValue(undefined)).toBe('');
    expect(formatAxValue({ type: 'string' })).toBe('');
  });
});

describe('layoutKind', () => {
  it('classifies grid and flex containers', () => {
    expect(layoutKind('grid')).toBe('grid');
    expect(layoutKind('inline-grid')).toBe('grid');
    expect(layoutKind('flex')).toBe('flex');
    expect(layoutKind('inline-flex')).toBe('flex');
  });
  it('returns null otherwise', () => {
    expect(layoutKind('block')).toBeNull();
    expect(layoutKind(null)).toBeNull();
    expect(layoutKind(undefined)).toBeNull();
  });
});
