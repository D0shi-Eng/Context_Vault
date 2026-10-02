import { describe, expect, it } from 'vitest';

import { ContextVaultError } from '../../src/domain/errors/context-vault-error.js';
import {
  buildSnapshotSeed,
  isIntentExpired,
  isIntentSnapshotCurrent,
  isWellFormedEnvelopeId,
  isWellFormedPurgeIntentId,
  validatePurgeRequest,
} from '../../src/domain/preparation/purge-intent-policy.js';

describe('purge request validation', () => {
  it('accepts a preview for a single envelope', () => {
    expect(
      validatePurgeRequest({
        operation: 'preview',
        target: { kind: 'envelope', envelopeId: 'cv_env_abcdefghijklmnop' },
      }),
    ).toEqual({
      operation: 'preview',
      target: { kind: 'envelope', envelopeId: 'cv_env_abcdefghijklmnop' },
    });
  });

  it('accepts a preview for all derived state', () => {
    expect(
      validatePurgeRequest({
        operation: 'preview',
        target: { kind: 'all_derived_state' },
      }),
    ).toEqual({
      operation: 'preview',
      target: { kind: 'all_derived_state' },
    });
  });

  it('accepts an execute command with a well-formed intent identifier', () => {
    expect(
      validatePurgeRequest({
        operation: 'execute',
        purgeIntentId: 'cv_pur_abcdefghijklmnop',
      }),
    ).toEqual({ operation: 'execute', purgeIntentId: 'cv_pur_abcdefghijklmnop' });
  });

  it.each([
    ['a non-object request', 'purge'],
    ['a null request', null],
    ['an undefined request', undefined],
    ['an unknown operation', { operation: 'delete', target: { kind: 'all_derived_state' } }],
    ['a missing operation', { target: { kind: 'all_derived_state' } }],
    ['a preview without a target', { operation: 'preview' }],
    ['a preview with a null target', { operation: 'preview', target: null }],
    ['a preview with a malformed target', { operation: 'preview', target: { kind: 'other' } }],
    [
      'a preview with a malformed envelope identifier',
      { operation: 'preview', target: { kind: 'envelope', envelopeId: 'not-an-id' } },
    ],
    [
      'a preview that leaks a source path',
      {
        operation: 'preview',
        target: { kind: 'envelope', envelopeId: 'cv_env_abcdefghijklmnop', path: 'x.txt' },
      },
    ],
    [
      'a whole-state preview with an unexpected field',
      { operation: 'preview', target: { kind: 'all_derived_state', extra: true } },
    ],
    ['an execute without an intent identifier', { operation: 'execute' }],
    [
      'an execute with a malformed intent identifier',
      { operation: 'execute', purgeIntentId: 'cv_corr_fallback00000000' },
    ],
    [
      'an execute carrying a target',
      {
        operation: 'execute',
        purgeIntentId: 'cv_pur_abcdefghijklmnop',
        target: { kind: 'all_derived_state' },
      },
    ],
    [
      'a preview carrying an intent identifier',
      {
        operation: 'preview',
        target: { kind: 'all_derived_state' },
        purgeIntentId: 'cv_pur_abcdefghijklmnop',
      },
    ],
  ])('rejects %s', (_name, request) => {
    try {
      validatePurgeRequest(request);
      expect.fail('Expected the purge request to be rejected.');
    } catch (error: unknown) {
      if (error instanceof ContextVaultError) {
        expect(error.code).toBe('CV_INPUT_INVALID');
        expect(error.message).not.toContain('path');
        return;
      }
      throw error;
    }
  });
});

describe('purge intent lifecycle rules', () => {
  const intent = {
    intentId: 'cv_pur_abcdefghijklmnop',
    sessionId: 'cv_ses_abcdefghijklmnop',
    targetKind: 'envelope' as const,
    envelopeId: 'cv_env_abcdefghijklmnop',
    snapshotDigest: `sha256:${'a'.repeat(64)}`,
    envelopeCount: 1,
    derivedBytes: 512,
    expiresAt: new Date('2026-09-10T12:30:00.000Z'),
    consumed: false,
  };

  it('treats an intent as unexpired before its expiry instant', () => {
    expect(isIntentExpired(intent, new Date('2026-09-10T12:29:59.999Z'))).toBe(false);
  });

  it('treats an intent as expired exactly at and after its expiry instant', () => {
    expect(isIntentExpired(intent, new Date('2026-09-10T12:30:00.000Z'))).toBe(true);
    expect(isIntentExpired(intent, new Date('2026-09-10T12:30:00.001Z'))).toBe(true);
  });

  it('requires an exact snapshot match on count, bytes, and digest', () => {
    expect(
      isIntentSnapshotCurrent(intent, {
        envelopeCount: 1,
        derivedBytes: 512,
        snapshotDigest: `sha256:${'a'.repeat(64)}`,
      }),
    ).toBe(true);
    expect(
      isIntentSnapshotCurrent(intent, {
        envelopeCount: 2,
        derivedBytes: 512,
        snapshotDigest: `sha256:${'a'.repeat(64)}`,
      }),
    ).toBe(false);
    expect(
      isIntentSnapshotCurrent(intent, {
        envelopeCount: 1,
        derivedBytes: 1024,
        snapshotDigest: `sha256:${'a'.repeat(64)}`,
      }),
    ).toBe(false);
    expect(
      isIntentSnapshotCurrent(intent, {
        envelopeCount: 1,
        derivedBytes: 512,
        snapshotDigest: `sha256:${'b'.repeat(64)}`,
      }),
    ).toBe(false);
  });

  it('binds whole-state snapshots to the store version while leaving envelope snapshots independent', () => {
    const wholeStateSeed = buildSnapshotSeed({
      sessionId: intent.sessionId,
      targetKind: 'all_derived_state',
      envelopeId: null,
      targetFingerprint: null,
      envelopeCount: 2,
      derivedBytes: 1024,
      version: 7,
    });
    const envelopeSeed = buildSnapshotSeed({
      sessionId: intent.sessionId,
      targetKind: 'envelope',
      envelopeId: intent.envelopeId,
      targetFingerprint: intent.snapshotDigest,
      envelopeCount: 1,
      derivedBytes: 512,
    });

    expect(wholeStateSeed).toBe(
      [intent.sessionId, 'all_derived_state', '-', '-', '2', '1024', '7'].join('|'),
    );
    expect(envelopeSeed).toBe(
      [
        intent.sessionId,
        'envelope',
        intent.envelopeId,
        intent.snapshotDigest,
        '1',
        '512',
        '-',
      ].join('|'),
    );
    expect(wholeStateSeed).not.toBe(envelopeSeed);
  });
});

describe('purge identifier validation', () => {
  it('matches the documented identifier shapes', () => {
    expect(isWellFormedPurgeIntentId('cv_pur_abcdefghijklmnop')).toBe(true);
    expect(isWellFormedPurgeIntentId('cv_pur_abc')).toBe(false);
    expect(isWellFormedPurgeIntentId('cv_pur_abcdefghijklmnop!')).toBe(false);
    expect(isWellFormedPurgeIntentId(`cv_pur_${'a'.repeat(200)}`)).toBe(false);
    expect(isWellFormedPurgeIntentId('cv_env_abcdefghijklmnop')).toBe(false);
    expect(isWellFormedPurgeIntentId('not-an-intent-id')).toBe(false);
    expect(isWellFormedEnvelopeId('cv_env_abcdefghijklmnop')).toBe(true);
    expect(isWellFormedEnvelopeId('cv_env_abc')).toBe(false);
    expect(isWellFormedEnvelopeId('cv_env_abcdefghijklmnop!')).toBe(false);
    expect(isWellFormedEnvelopeId(`cv_env_${'a'.repeat(200)}`)).toBe(false);
    expect(isWellFormedEnvelopeId('cv_pur_abcdefghijklmnop')).toBe(false);
    expect(isWellFormedEnvelopeId('')).toBe(false);
  });

  it('accepts identifiers exactly at the supported identity bounds', () => {
    expect(isWellFormedPurgeIntentId(`cv_pur_${'a'.repeat(16)}`)).toBe(true);
    expect(isWellFormedPurgeIntentId(`cv_pur_${'a'.repeat(128)}`)).toBe(true);
    expect(isWellFormedEnvelopeId(`cv_env_${'a'.repeat(16)}`)).toBe(true);
    expect(isWellFormedEnvelopeId(`cv_env_${'a'.repeat(128)}`)).toBe(true);
    expect(isWellFormedPurgeIntentId(`cv_pur_${'a'.repeat(15)}`)).toBe(false);
    expect(isWellFormedEnvelopeId(`cv_env_${'a'.repeat(129)}`)).toBe(false);
  });

  it.each([
    ['an all-uppercase identity', `cv_pur_${'A'.repeat(16)}`, true],
    ['an identity at the uppercase ceiling', `cv_pur_${'Z'.repeat(16)}`, true],
    ['an all-digit identity', `cv_pur_${'0'.repeat(16)}`, true],
    ['an identity at the digit ceiling', `cv_pur_${'9'.repeat(16)}`, true],
    ['a character before the uppercase range', `cv_pur_${'@'.repeat(16)}`, false],
    ['a character after the uppercase range', `cv_pur_${'['.repeat(16)}`, false],
    ['a character before the lowercase range', `cv_pur_${'`'.repeat(16)}`, false],
    ['a character after the lowercase range', `cv_pur_${'{'.repeat(16)}`, false],
    ['a character before the digit range', `cv_pur_${'/'.repeat(16)}`, false],
    ['a character after the digit range', `cv_pur_${':'.repeat(16)}`, false],
    ['an identifier without its prefix', 'z'.repeat(27), false],
  ])('validates %s as %s', (_name, candidate, expected) => {
    expect(isWellFormedPurgeIntentId(candidate)).toBe(expected);
    expect(isWellFormedEnvelopeId(candidate.replace('cv_pur_', 'cv_env_'))).toBe(expected);
  });
});
