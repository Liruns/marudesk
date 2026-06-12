import { describe, expect, it } from 'vitest';
import { parseCookieHeader, parseSetCookieHeader } from './network-cookies';

describe('parseCookieHeader', () => {
  it('splits a Cookie header into name/value rows', () => {
    expect(parseCookieHeader('sid=abc123; theme=dark')).toEqual([
      { name: 'sid', value: 'abc123' },
      { name: 'theme', value: 'dark' },
    ]);
  });

  it('keeps = inside the value (only the first = splits)', () => {
    expect(parseCookieHeader('token=a=b=c')).toEqual([
      { name: 'token', value: 'a=b=c' },
    ]);
  });

  it('turns a bare token into a row with an empty value', () => {
    expect(parseCookieHeader('orphan; a=1')).toEqual([
      { name: 'orphan', value: '' },
      { name: 'a', value: '1' },
    ]);
  });

  it('returns [] for an absent or empty header', () => {
    expect(parseCookieHeader(undefined)).toEqual([]);
    expect(parseCookieHeader('')).toEqual([]);
  });
});

describe('parseSetCookieHeader', () => {
  it('parses one cookie with value and flag attributes', () => {
    expect(
      parseSetCookieHeader('sid=abc; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Lax'),
    ).toEqual([
      {
        name: 'sid',
        value: 'abc',
        attributes: [
          { name: 'Path', value: '/' },
          { name: 'Max-Age', value: '3600' },
          { name: 'Secure' },
          { name: 'HttpOnly' },
          { name: 'SameSite', value: 'Lax' },
        ],
      },
    ]);
  });

  it('splits CDP-folded multiple Set-Cookie headers on newline', () => {
    const folded = 'a=1; Path=/\nb=2; Secure';
    expect(parseSetCookieHeader(folded)).toEqual([
      { name: 'a', value: '1', attributes: [{ name: 'Path', value: '/' }] },
      { name: 'b', value: '2', attributes: [{ name: 'Secure' }] },
    ]);
  });

  it('keeps commas inside an Expires attribute value', () => {
    const [cookie] = parseSetCookieHeader(
      'sid=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
    );
    expect(cookie.attributes).toEqual([
      { name: 'Expires', value: 'Wed, 21 Oct 2026 07:28:00 GMT' },
    ]);
  });

  it('drops a malformed line without name=value but keeps the rest', () => {
    expect(parseSetCookieHeader('not-a-cookie\nok=1')).toEqual([
      { name: 'ok', value: '1', attributes: [] },
    ]);
  });

  it('returns [] for an absent header', () => {
    expect(parseSetCookieHeader(undefined)).toEqual([]);
  });
});
