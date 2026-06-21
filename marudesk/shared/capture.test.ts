import { describe, expect, it } from 'vitest';
import { coerceElementCapture, type ElementCapture } from './capture';

/** A deterministic id minter so assertions don't depend on a counter/clock. */
function makeId(): string {
  return 'host-id';
}

/** A well-formed element-capture payload as the inspect overlay would send it. */
function wellFormedPayload(): Record<string, unknown> {
  return {
    kind: 'element',
    id: 'page-supplied-id',
    timestamp: 123,
    url: 'https://example.test/page',
    selector: 'div.card > button',
    tagName: 'button',
    text: 'Click me',
    attributes: { id: 'go', 'data-x': 'y' },
    rect: { x: 10, y: 20, width: 30, height: 40 },
    outerHTML: '<button id="go">Click me</button>',
  };
}

describe('coerceElementCapture', () => {
  it('accepts a well-formed payload and stamps a fresh host id', () => {
    const cap = coerceElementCapture(wellFormedPayload(), makeId);
    expect(cap).not.toBeNull();
    const c = cap as ElementCapture;
    expect(c.kind).toBe('element');
    // The page-supplied id is discarded in favor of the host-minted one.
    expect(c.id).toBe('host-id');
    expect(c.id).not.toBe('page-supplied-id');
    expect(c.selector).toBe('div.card > button');
    expect(c.tagName).toBe('button');
    expect(c.text).toBe('Click me');
    expect(c.url).toBe('https://example.test/page');
    expect(c.attributes).toEqual({ id: 'go', 'data-x': 'y' });
    expect(c.rect).toEqual({ x: 10, y: 20, width: 30, height: 40 });
    expect(c.outerHTML).toBe('<button id="go">Click me</button>');
  });

  it('mints a fresh id even when none was supplied', () => {
    const payload = wellFormedPayload();
    delete payload.id;
    const c = coerceElementCapture(payload, makeId) as ElementCapture;
    expect(c.id).toBe('host-id');
  });

  it('clamps oversized text and outerHTML to bounded lengths', () => {
    const payload = wellFormedPayload();
    payload.text = 'a'.repeat(50_000);
    payload.outerHTML = 'b'.repeat(100_000);
    const c = coerceElementCapture(payload, makeId) as ElementCapture;
    expect(c.text.length).toBeLessThan(50_000);
    expect(c.text.length).toBe(4_000);
    expect((c.outerHTML ?? '').length).toBe(20_000);
  });

  it('clamps oversized selector and url', () => {
    const payload = wellFormedPayload();
    payload.selector = 's'.repeat(10_000);
    payload.url = 'u'.repeat(10_000);
    const c = coerceElementCapture(payload, makeId) as ElementCapture;
    expect(c.selector.length).toBe(2_000);
    expect(c.url.length).toBe(4_000);
  });

  it('drops non-string attribute values and caps attribute count', () => {
    const payload = wellFormedPayload();
    const attrs: Record<string, unknown> = { keepMe: 'ok', bad: 5, nested: {} };
    for (let i = 0; i < 200; i += 1) attrs[`a${i}`] = String(i);
    payload.attributes = attrs;
    const c = coerceElementCapture(payload, makeId) as ElementCapture;
    expect(c.attributes.keepMe).toBe('ok');
    expect('bad' in c.attributes).toBe(false);
    expect('nested' in c.attributes).toBe(false);
    expect(Object.keys(c.attributes).length).toBeLessThanOrEqual(64);
  });

  it('coerces non-finite rect fields to 0', () => {
    const payload = wellFormedPayload();
    payload.rect = { x: Number.NaN, y: 'nope', width: Infinity, height: 5 };
    const c = coerceElementCapture(payload, makeId) as ElementCapture;
    expect(c.rect).toEqual({ x: 0, y: 0, width: 0, height: 5 });
  });

  it('omits outerHTML when it is not a string', () => {
    const payload = wellFormedPayload();
    payload.outerHTML = 12345;
    const c = coerceElementCapture(payload, makeId) as ElementCapture;
    expect(c.outerHTML).toBeUndefined();
  });

  it('returns null for a non-object payload', () => {
    expect(coerceElementCapture(null, makeId)).toBeNull();
    expect(coerceElementCapture('string', makeId)).toBeNull();
    expect(coerceElementCapture(42, makeId)).toBeNull();
    expect(coerceElementCapture(['a'], makeId)).toBeNull();
  });

  it('returns null when kind is not "element"', () => {
    const payload = wellFormedPayload();
    payload.kind = 'console-error';
    expect(coerceElementCapture(payload, makeId)).toBeNull();
  });

  it('returns null when required string fields are missing or garbage', () => {
    const missingSelector = wellFormedPayload();
    delete missingSelector.selector;
    expect(coerceElementCapture(missingSelector, makeId)).toBeNull();

    const garbageTag = wellFormedPayload();
    garbageTag.tagName = 99;
    expect(coerceElementCapture(garbageTag, makeId)).toBeNull();

    const garbageText = wellFormedPayload();
    garbageText.text = {};
    expect(coerceElementCapture(garbageText, makeId)).toBeNull();

    const garbageUrl = wellFormedPayload();
    garbageUrl.url = null;
    expect(coerceElementCapture(garbageUrl, makeId)).toBeNull();
  });

  it('returns null when rect is not an object', () => {
    const payload = wellFormedPayload();
    payload.rect = 'not-a-rect';
    expect(coerceElementCapture(payload, makeId)).toBeNull();
  });
});
