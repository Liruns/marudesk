import { describe, expect, it } from 'vitest';
import {
  describeSecurityIssue,
  parseVisibleSecurityState,
  securityStateLabel,
} from './security-utils';

describe('parseVisibleSecurityState', () => {
  it('rejects shapes without a visibleSecurityState object', () => {
    expect(parseVisibleSecurityState(null)).toBeNull();
    expect(parseVisibleSecurityState({})).toBeNull();
    expect(parseVisibleSecurityState({ visibleSecurityState: 'secure' })).toBeNull();
  });

  it('parses the full wire shape', () => {
    const parsed = parseVisibleSecurityState({
      visibleSecurityState: {
        securityState: 'secure',
        certificateSecurityState: {
          protocol: 'TLS 1.3',
          keyExchange: '',
          keyExchangeGroup: 'X25519',
          cipher: 'AES_128_GCM',
          subjectName: 'example.com',
          issuer: 'R3',
          validFrom: 1700000000,
          validTo: 1710000000,
          certificate: ['pem'],
        },
        securityStateIssueIds: ['displayed-mixed-content', 7],
      },
    });
    expect(parsed).toEqual({
      securityState: 'secure',
      certificate: {
        protocol: 'TLS 1.3',
        keyExchange: '',
        keyExchangeGroup: 'X25519',
        cipher: 'AES_128_GCM',
        subjectName: 'example.com',
        issuer: 'R3',
        validFrom: 1700000000,
        validTo: 1710000000,
      },
      issueIds: ['displayed-mixed-content'], // non-strings filtered
    });
  });

  it('defaults an unrecognized securityState to unknown, without a certificate', () => {
    const parsed = parseVisibleSecurityState({
      visibleSecurityState: { securityState: 'something-new' },
    });
    expect(parsed?.securityState).toBe('unknown');
    expect(parsed?.certificate).toBeUndefined();
    expect(parsed?.issueIds).toEqual([]);
  });
});

describe('securityStateLabel', () => {
  it('maps states to the panel verdicts', () => {
    expect(securityStateLabel('secure')).toBe('Secure');
    expect(securityStateLabel('insecure')).toBe('Not secure');
    expect(securityStateLabel('insecure-broken')).toBe('Not secure');
    expect(securityStateLabel('neutral')).toBe('Not secure');
    expect(securityStateLabel('unknown')).toBe('Unknown');
  });
});

describe('describeSecurityIssue', () => {
  it('maps known issue ids with severity', () => {
    const issue = describeSecurityIssue('ran-mixed-content');
    expect(issue.severity).toBe('error');
    expect(issue.label).toContain('mixed content');
  });

  it('falls back to the raw id for unknown issues', () => {
    expect(describeSecurityIssue('brand-new-issue')).toEqual({
      id: 'brand-new-issue',
      label: 'brand-new-issue',
      severity: 'info',
    });
  });
});
