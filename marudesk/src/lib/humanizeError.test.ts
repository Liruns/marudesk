import { describe, it, expect } from 'vitest';
import { humanizeError, isNoWorkspaceError } from './humanizeError';

describe('humanizeError', () => {
  it('strips the Electron remote-invoke wrapper and channel tag', () => {
    const raw =
      "Error invoking remote method 'git:status': Error: git:status: no workspace is open";
    expect(humanizeError(raw)).toBe('No workspace is open');
  });

  it('collapses repeated Error: prefixes', () => {
    expect(humanizeError('Error: Error: something broke')).toBe('Something broke');
  });

  it('leaves a plain sentence alone (just capitalizes)', () => {
    expect(humanizeError('disk is full')).toBe('Disk is full');
  });

  it('does not eat a URL that looks like a channel tag', () => {
    expect(humanizeError('https://example.com is unreachable')).toBe(
      'https://example.com is unreachable',
    );
  });

  it('accepts Error instances and nullish input', () => {
    expect(humanizeError(new Error('boom'))).toBe('Boom');
    expect(humanizeError(null)).toBe('');
    expect(humanizeError(undefined)).toBe('');
  });
});

describe('isNoWorkspaceError', () => {
  it('detects the no-workspace case regardless of wrapping', () => {
    expect(isNoWorkspaceError("git:status: no workspace is open")).toBe(true);
    expect(isNoWorkspaceError('No Workspace')).toBe(true);
    expect(isNoWorkspaceError('permission denied')).toBe(false);
  });
});
